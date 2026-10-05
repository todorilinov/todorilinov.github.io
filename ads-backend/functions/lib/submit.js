'use strict';
// A request from advertise.html becomes submissions/{id} (ADS-PLAN.md, sections 4–8), and the
// advertiser can send an updated version of it later. Everything outside (database, bucket, mail,
// clock) is passed in, so it can be tested with fakes.

const crypto = require('crypto');
const { SLOTS, MAX_BYTES, validateInput, sniff, checkFile } = require('./spec');
const { receivedEmail, adminEmail, updatedAdminEmail } = require('./mail');
const { normalizePricing } = require('./pricing');

const TERMS_VERSION = 'draft-0';
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const MAX_PER_IP_HOUR = 5;
const MAX_PER_DAY = 100;

class InvalidRequest extends Error {
  constructor(errors) { super('Please fix the highlighted fields.'); this.errors = errors; }
}
class RateLimited extends Error {
  constructor(msg) { super(msg || 'Too many requests. Please try again later.'); }
}
/** The link (id + token) does not match a request, or the request is not in a state that allows this. */
class NotAllowed extends Error {
  constructor(msg, code) { super(msg); this.code = code || 'not-found'; }
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const ipHashOf = ip => sha256((ip || 'unknown') + '|tiapps-ads').slice(0, 32);

/** Counts one hit under [key] in the current window. True while it is still within [max]. */
async function hit(db, key, max, windowMs, now, n = 1) {
  // One root per day (ratelimit/{day}/...): the daily clean-up deletes whole old days at once.
  const r = await db.ref('ratelimit/' + Math.floor(now / DAY_MS) + '/' + key + '/' + Math.floor(now / windowMs)).transaction(cur => (cur || 0) + n);
  return r.snapshot.val() <= max;
}

/** A new request: false when this address, or the whole site, has had too many today. */
async function countRequest(db, ipHash, now) {
  if (!(await hit(db, 'ip/' + ipHash, MAX_PER_IP_HOUR, HOUR_MS, now))) return false;
  return hit(db, 'all', MAX_PER_DAY, DAY_MS, now);
}

/** Does the token of the link belong to this request? */
async function tokenOk(db, id, token) {
  if (typeof id !== 'string' || typeof token !== 'string' || !/^[-\w]{10,40}$/.test(id) || !/^[-\w]{16,64}$/.test(token)) return false;
  const stored = (await db.ref('tokens/' + id).get()).val();
  if (typeof stored !== 'string') return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(stored)), Buffer.from(sha256(token)));
}

/** The price list from the database (or the defaults while nothing is saved). */
async function loadPricing(db) {
  return normalizePricing((await db.ref('pricing').get()).val());
}

const statusUrl = (baseUrl, id, token) => baseUrl + '/ad-status.html?i=' + id + '&t=' + token;

async function safeSend(ctx, m, who) {
  try { await ctx.sendMail(m); } catch (e) { if (ctx.log) ctx.log('mail failed', { to: who, error: e.message }); }
}

/**
 * Reads the uploads: what a file really is matters, not what the browser said.
 * @returns {{checked:object[], errors:{field:string,msg:string}[]}}
 */
async function checkUploads(files, bucket) {
  const checked = [], errors = [];
  for (const f of files) {
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
  return { checked, errors };
}

/** Moves the files out of uploads/ (cleaned every day) into the request's own folder. Returns the slots map. */
async function moveUploads(checked, bucket, id) {
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
  return slots;
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

  const ipHash = ipHashOf(ctx.ip);
  if (!(await countRequest(db, ipHash, now))) throw new RateLimited();

  const { errors, value } = validateInput(data, now, await loadPricing(db));
  if (errors.length) throw new InvalidRequest(errors);
  const up = await checkUploads(value.files, bucket);
  if (up.errors.length) throw new InvalidRequest(up.errors);

  const id = db.ref('submissions').push().key;
  const ref = sha256(id).slice(0, 8).toUpperCase();
  const slots = await moveUploads(up.checked, bucket, id);

  const token = ctx.newToken();
  const a = value.advertiser;
  const rec = {
    status: 'pending', createdAt: now, updatedAt: now, ref,
    advertiser: { name: a.name, email: a.email, country: a.country },
    title: value.ad.title, clickUrl: value.ad.clickUrl,
    apps: Object.fromEntries(value.apps.map(x => [x, true])),
    slots, from: value.from, budget: value.budget,
    termsAccepted: { version: TERMS_VERSION, at: now },
    ipHash,
    log: { [now]: { by: 'advertiser', from: null, to: 'pending' } },
  };
  if (a.company) rec.advertiser.company = a.company;
  if (a.vat) rec.advertiser.vat = a.vat;
  if (value.ad.description) rec.description = value.ad.description;
  if (value.countries.length) rec.countries = value.countries;
  await db.ref('submissions/' + id).set(rec);
  // Only the functions read tokens/ (the rules give nobody else access): the status link can be re-sent in later emails.
  await db.ref('tokens/' + id).set(token);

  // The request is saved; a failed email must not lose it.
  const adminUrl = ctx.baseUrl + '/admin-ads.html#requests';
  await safeSend(ctx, { to: a.email, ...receivedEmail(rec, ref, statusUrl(ctx.baseUrl, id, token)) }, 'advertiser');
  await safeSend(ctx, { to: ctx.adminEmail, replyTo: a.email, ...adminEmail(rec, ref, adminUrl) }, 'admin');
  return { ok: true, ref };
}

/**
 * The advertiser sends a new version of a request that was sent back or rejected.
 * @param {object} data  { id, token, ad, apps, countries, startDate, budget, terms, website }
 */
async function processResubmission(data, ctx) {
  const { now, db, bucket } = ctx;
  data = data && typeof data === 'object' ? data : {};
  if (typeof data.website === 'string' && data.website.trim()) return { ok: true };

  const ipHash = ipHashOf(ctx.ip);
  if (!(await hit(db, 'resubmit/' + ipHash, 20, HOUR_MS, now))) throw new RateLimited();
  const id = data.id;
  if (!(await tokenOk(db, id, data.token))) throw new NotAllowed('This link is not valid.');

  const rec = (await db.ref('submissions/' + id).get()).val();
  if (!rec) throw new NotAllowed('This link is not valid.');
  if (!['changes_requested', 'rejected'].includes(rec.status)) {
    throw new NotAllowed('This request cannot be changed any more.', 'failed-precondition');
  }

  // The advertiser's own details stay as they were.
  const { errors, value } = validateInput({ ...data, advertiser: rec.advertiser }, now, await loadPricing(db));
  if (errors.length) throw new InvalidRequest(errors);
  const up = await checkUploads(value.files, bucket);
  if (up.errors.length) throw new InvalidRequest(up.errors);
  const slots = await moveUploads(up.checked, bucket, id);

  // Files of the old version that the new one does not use any more.
  const keep = new Set(Object.values(slots).flatMap(m => Object.values(m).map(f => f.file)));
  for (const m of Object.values(rec.slots || {})) {
    for (const f of Object.values(m || {})) {
      if (f && f.file && !keep.has(f.file)) await bucket.file(f.file).delete().catch(() => {});
    }
  }

  const changes = {
    title: value.ad.title, clickUrl: value.ad.clickUrl,
    description: value.ad.description || null,
    apps: Object.fromEntries(value.apps.map(x => [x, true])),
    slots, countries: value.countries.length ? value.countries : null,
    from: value.from, budget: value.budget,
    termsAccepted: { version: TERMS_VERSION, at: now },
    status: 'pending', review: null, updatedAt: now,
  };
  changes['log/' + now] = { by: 'advertiser', from: rec.status, to: 'pending', note: 'sent a new version' };
  await db.ref('submissions/' + id).update(changes);

  const updated = { ...rec, ...changes, advertiser: rec.advertiser, countries: changes.countries || [], description: changes.description || '' };
  await safeSend(ctx, { to: ctx.adminEmail, replyTo: rec.advertiser.email, ...updatedAdminEmail(updated, rec.ref, ctx.baseUrl + '/admin-ads.html#requests') }, 'admin');
  return { ok: true, ref: rec.ref };
}

module.exports = {
  processSubmission, processResubmission, InvalidRequest, RateLimited, NotAllowed,
  countRequest, hit, tokenOk, loadPricing, statusUrl, safeSend, ipHashOf, sha256, TERMS_VERSION, DAY_MS,
};
