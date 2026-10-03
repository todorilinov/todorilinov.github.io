'use strict';
// A request from advertise.html becomes submissions/{id} (ADS-PLAN.md, sections 4–8).
// Everything outside (database, bucket, mail, clock) is passed in, so it can be tested with fakes.

const crypto = require('crypto');
const { SLOTS, MAX_BYTES, validateInput, sniff, checkFile } = require('./spec');
const { receivedEmail, adminEmail } = require('./mail');

const TERMS_VERSION = 'draft-0';
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const MAX_PER_IP_HOUR = 5;
const MAX_PER_DAY = 100;

class InvalidRequest extends Error {
  constructor(errors) { super('Please fix the highlighted fields.'); this.errors = errors; }
}
class RateLimited extends Error {
  constructor() { super('Too many requests. Please try again later.'); }
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

/** Counts a request. Returns false when the IP or the whole site has had too many. */
async function countRequest(db, ipHash, now) {
  const bump = async path => {
    const r = await db.ref(path).transaction(cur => (cur || 0) + 1);
    return r.snapshot.val();
  };
  const hour = await bump('ratelimit/ip/' + ipHash + '/' + Math.floor(now / HOUR_MS));
  if (hour > MAX_PER_IP_HOUR) return false;
  const day = await bump('ratelimit/all/' + Math.floor(now / DAY_MS));
  return day <= MAX_PER_DAY;
}

/**
 * @param {object} data  what the form sent
 * @param {object} ctx   { now, ip, db, bucket, sendMail(msg), newToken(), adminEmail, baseUrl, log }
 * @returns {Promise<{ok:true, ref?:string}>}
 */
async function processSubmission(data, ctx) {
  const { now, db, bucket } = ctx;

  // A bot filled the hidden field: pretend it worked, store nothing.
  if (data && typeof data.website === 'string' && data.website.trim()) return { ok: true };

  const ipHash = sha256((ctx.ip || 'unknown') + '|tiapps-ads').slice(0, 32);
  if (!(await countRequest(db, ipHash, now))) throw new RateLimited();

  const { errors, value } = validateInput(data, now);
  if (errors.length) throw new InvalidRequest(errors);

  // Read the uploads: what a file really is matters, not what the browser said.
  const checked = [];
  for (const f of value.files) {
    const file = bucket.file(f.path);
    const field = 'file:' + f.app + '/' + f.slot;
    const [exists] = await file.exists();
    if (!exists) { errors.push({ field, msg: 'The upload is missing, please add the file again.' }); continue; }
    const [meta] = await file.getMetadata();
    const size = Number(meta.size);
    if (!(size > 0) || size > MAX_BYTES.video) { errors.push({ field, msg: 'The file is too large (6 MB at most).' }); continue; }
    // Images and GIFs are read whole. A big file is only read at the start, enough to recognise its format.
    const buf = (await file.download(size <= 3 * 1024 * 1024 ? {} : { start: 0, end: 63 }))[0];
    const info = sniff(buf);
    const msg = checkFile(f.slot, info, size);
    if (msg) { errors.push({ field, msg }); continue; }
    checked.push({ ...f, info, size });
  }
  if (errors.length) throw new InvalidRequest(errors);

  const id = db.ref('submissions').push().key;
  const ref = sha256(id).slice(0, 8).toUpperCase();

  // Move the files out of uploads/ (cleaned every day) into the request's own folder.
  const slots = {};
  for (const c of checked) {
    const dest = 'submissions/' + id + '/' + c.app + '_' + c.slot + '.' + c.info.ext;
    await bucket.file(c.path).move(dest);
    (slots[c.app] = slots[c.app] || {})[c.slot] = {
      file: dest,
      type: c.info.kind,
      w: c.info.kind === 'video' ? SLOTS[c.slot].w : c.info.w,
      h: c.info.kind === 'video' ? SLOTS[c.slot].h : c.info.h,
      size: c.size,
    };
  }

  const token = ctx.newToken();
  const a = value.advertiser;
  const rec = {
    status: 'pending', createdAt: now, updatedAt: now, ref,
    advertiser: { name: a.name, email: a.email, country: a.country },
    title: value.ad.title, clickUrl: value.ad.clickUrl,
    apps: Object.fromEntries(value.apps.map(x => [x, true])),
    slots, from: value.from, budget: value.budget,
    termsAccepted: { version: TERMS_VERSION, at: now },
    tokenHash: sha256(token), ipHash,
    log: { [now]: { by: 'advertiser', from: null, to: 'pending' } },
  };
  if (a.company) rec.advertiser.company = a.company;
  if (a.vat) rec.advertiser.vat = a.vat;
  if (value.ad.description) rec.description = value.ad.description;
  if (value.countries.length) rec.countries = value.countries;
  await db.ref('submissions/' + id).set(rec);

  // The request is saved; a failed email must not lose it.
  const statusUrl = ctx.baseUrl + '/ad-status.html?t=' + token;
  const adminUrl = ctx.baseUrl + '/admin-ads.html#requests';
  const mails = [
    { to: a.email, ...receivedEmail(rec, ref, statusUrl) },
    { to: ctx.adminEmail, replyTo: a.email, ...adminEmail(rec, ref, adminUrl) },
  ];
  for (const m of mails) {
    try { await ctx.sendMail(m); } catch (e) { if (ctx.log) ctx.log('mail failed', { to: m.to === a.email ? 'advertiser' : 'admin', error: e.message }); }
  }
  return { ok: true, ref };
}

module.exports = { processSubmission, InvalidRequest, RateLimited, countRequest, sha256, TERMS_VERSION };
