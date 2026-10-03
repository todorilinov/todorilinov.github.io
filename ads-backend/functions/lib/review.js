'use strict';
// What the admin does with a request, and what the advertiser sees of it (ADS-PLAN.md, sections 4, 5, 7).
// Everything outside (database, bucket, mail, clock) is passed in, so it can be tested with fakes.

const { SLOTS, APPS } = require('./spec');
const { tokenOk, statusUrl, safeSend, hit, ipHashOf, DAY_MS, NotAllowed, RateLimited } = require('./submit');
const { approvedEmail, rejectedEmail, changesEmail, paidEmail, expiredEmail } = require('./mail');

const PAY_WITHIN_DAYS = 14;
const MAX_AMOUNT = 1000000;

/** The admin asked for something that cannot be done; [code] is an HttpsError code. */
class ReviewError extends Error {
  constructor(msg, code) { super(msg); this.code = code || 'invalid-argument'; }
}

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim() : '').slice(0, max);

async function load(db, id) {
  const rec = typeof id === 'string' && /^[-\w]{10,40}$/.test(id) ? (await db.ref('submissions/' + id).get()).val() : null;
  if (!rec) throw new ReviewError('That request does not exist.', 'not-found');
  return rec;
}
async function linkOf(db, ctx, id) {
  const token = (await db.ref('tokens/' + id).get()).val();
  return token ? statusUrl(ctx.baseUrl, id, token) : ctx.baseUrl + '/ad-status.html';
}
const logEntry = (now, from, to, note) => ({ by: 'admin', from, to, ...(note ? { note } : {}) });

/**
 * approve | reject | changes
 * @param {{id:string, action:string, amount?:number, paymentLink?:string, note?:string}} d
 */
async function review(d, ctx) {
  const { db, now } = ctx;
  const rec = await load(db, d.id);
  const from = rec.status;
  const note = text(d.note, 500);
  const upd = { updatedAt: now };
  let mail;
  const adv = { to: rec.advertiser.email };

  if (d.action === 'approve') {
    if (from !== 'pending') throw new ReviewError('Only a request that is waiting for review can be approved.', 'failed-precondition');
    const amount = Math.round(Number(d.amount) * 100) / 100;
    if (!(amount > 0) || amount > MAX_AMOUNT) throw new ReviewError('Enter the price in EUR (more than 0).');
    const link = text(d.paymentLink, 300);
    if (!/^https:\/\/[^\s]+$/.test(link)) throw new ReviewError('The payment link must start with https:// and have no spaces.');
    upd.status = 'approved';
    upd.final = { amount, currency: 'EUR', ...(note ? { note } : {}) };
    upd.payment = { link };
    upd.payBy = now + PAY_WITHIN_DAYS * DAY_MS;
    upd.review = null;
    Object.assign(rec, upd);
    mail = approvedEmail(rec, rec.ref, await linkOf(db, ctx, d.id), upd.payBy);
  } else if (d.action === 'reject') {
    if (!['pending', 'approved'].includes(from)) throw new ReviewError('This request cannot be rejected now.', 'failed-precondition');
    if (note.length < 3) throw new ReviewError('Write the reason: the advertiser will read it.');
    upd.status = 'rejected';
    upd.review = { rejectReason: note, at: now };
    upd.payment = null;
    upd.payBy = null;
    Object.assign(rec, upd);
    mail = rejectedEmail(rec, rec.ref, await linkOf(db, ctx, d.id));
  } else if (d.action === 'changes') {
    if (from !== 'pending') throw new ReviewError('Only a request that is waiting for review can be sent back.', 'failed-precondition');
    if (note.length < 3) throw new ReviewError('Write what needs to change: the advertiser will read it.');
    upd.status = 'changes_requested';
    upd.review = { note, at: now };
    Object.assign(rec, upd);
    mail = changesEmail(rec, rec.ref, await linkOf(db, ctx, d.id));
  } else {
    throw new ReviewError('Unknown action.');
  }

  await db.ref('submissions/' + d.id).update({ ...upd, ['log/' + now]: logEntry(now, from, upd.status, d.action === 'approve' ? '' : note) });
  await safeSend(ctx, { ...adv, ...mail }, 'advertiser');
  return { status: upd.status };
}

const publicUrl = (bucketName, path) => 'https://firebasestorage.googleapis.com/v0/b/' + bucketName + '/o/' + encodeURIComponent(path) + '?alt=media';

/**
 * The money arrived: the files are copied where the apps can read them and a campaign is created.
 * The campaign starts paused; the admin switches it on (decision of 2026-10-03).
 * @param {{id:string, reference?:string}} d
 */
async function markPaid(d, ctx) {
  const { db, bucket, now } = ctx;
  const rec = await load(db, d.id);
  if (rec.campaignId) return { campaignId: rec.campaignId, already: true };
  if (rec.status !== 'approved') throw new ReviewError('Only an approved request can be marked as paid.', 'failed-precondition');

  const cid = db.ref('campaigns').push().key;
  const slots = {};
  for (const [app, m] of Object.entries(rec.slots || {})) {
    for (const [slot, f] of Object.entries(m || {})) {
      const ext = String(f.file).split('.').pop();
      const dest = 'creatives/' + cid + '/' + app + '_' + slot + '_' + now + '.' + ext;
      await bucket.file(f.file).copy(dest);
      (slots[app] = slots[app] || {})[slot] = { type: f.type, url: publicUrl(ctx.bucketName, dest), path: dest, w: f.w, h: f.h, bytes: f.size };
    }
  }
  const campaign = {
    title: rec.title, clickUrl: rec.clickUrl, kind: 'paid', status: 'paused', weight: 20,
    cap: { n: 3, per: 'hour' }, from: rec.from, apps: rec.apps, slots,
    createdAt: now, updatedAt: now, source: 'submission', submissionId: d.id,
    budget: { model: 'impressions', target: rec.budget.target }, delivered: 0,
  };
  if (rec.description) campaign.description = rec.description;
  if (rec.countries && rec.countries.length) campaign.countries = rec.countries;
  await db.ref('campaigns/' + cid).set(campaign);

  const ref = text(d.reference, 80);
  const upd = {
    status: 'paid', updatedAt: now, campaignId: cid,
    payment: { ...(rec.payment || {}), paidAt: now, ...(ref ? { ref } : {}) },
    payBy: null,
  };
  await db.ref('submissions/' + d.id).update({ ...upd, ['log/' + now]: logEntry(now, 'approved', 'paid', ref) });
  await safeSend(ctx, { to: rec.advertiser.email, ...paidEmail(rec, rec.ref, await linkOf(db, ctx, d.id)) }, 'advertiser');
  return { campaignId: cid };
}

/** Approvals nobody paid within the time become expired. Returns how many. */
async function expireUnpaid(ctx) {
  const { db, now } = ctx;
  const all = (await db.ref('submissions').get()).val() || {};
  let n = 0;
  for (const [id, rec] of Object.entries(all)) {
    if (!rec || rec.status !== 'approved' || !(rec.payBy < now)) continue;
    await db.ref('submissions/' + id).update({
      status: 'expired', updatedAt: now, payBy: null, payment: null,
      ['log/' + now]: { by: 'system', from: 'approved', to: 'expired' },
    });
    await safeSend(ctx, { to: rec.advertiser.email, ...expiredEmail(rec, rec.ref) }, 'advertiser');
    n++;
  }
  return n;
}

/** What the campaign says about a paid request. */
function effectiveStatus(rec, campaign) {
  if (rec.status === 'paid' && campaign) {
    if (campaign.status === 'active') return 'active';
    if (campaign.status === 'finished') return 'finished';
  }
  return rec.status;
}

/** The part of a request the advertiser may see: no email address, no address hashes, nothing internal. */
function publicView(rec, campaign) {
  const status = effectiveStatus(rec, campaign);
  const v = {
    ref: rec.ref, status, title: rec.title, createdAt: rec.createdAt, updatedAt: rec.updatedAt,
    from: rec.from, budget: { target: rec.budget && rec.budget.target },
    description: rec.description || '', clickUrl: rec.clickUrl, countries: rec.countries || [],
    apps: Object.entries(rec.slots || {}).map(([app, m]) => ({
      app, name: APPS[app] ? APPS[app].name : app,
      slots: Object.keys(m || {}).map(s => ({ slot: s, label: SLOTS[s] ? SLOTS[s].label : s })),
    })),
    canChange: ['changes_requested', 'rejected'].includes(rec.status),
    log: Object.entries(rec.log || {}).sort((a, b) => Number(a[0]) - Number(b[0])).map(([t, l]) => ({ at: Number(t), by: l.by, to: l.to })),
  };
  if (rec.final) v.final = { amount: rec.final.amount, currency: rec.final.currency, note: rec.final.note || '' };
  if (rec.status === 'approved') { v.payLink = rec.payment && rec.payment.link; v.payBy = rec.payBy; }
  if (rec.review && ['changes_requested', 'rejected'].includes(rec.status)) v.review = { note: rec.review.note || '', rejectReason: rec.review.rejectReason || '' };
  if (rec.payment && rec.payment.paidAt) v.paidAt = rec.payment.paidAt;
  return v;
}

/** @param {{id:string, token:string}} d */
async function statusGet(d, ctx) {
  const { db, now } = ctx;
  if (!(await hit(db, 'status/' + ipHashOf(ctx.ip), 120, 3600000, now))) throw new RateLimited();
  if (!(await tokenOk(db, d && d.id, d && d.token))) throw new NotAllowed('This link is not valid.');
  const rec = (await db.ref('submissions/' + d.id).get()).val();
  if (!rec) throw new NotAllowed('This link is not valid.');
  const campaign = rec.campaignId ? (await db.ref('campaigns/' + rec.campaignId).get()).val() : null;
  return publicView(rec, campaign);
}

module.exports = { review, markPaid, expireUnpaid, statusGet, publicView, effectiveStatus, ReviewError, PAY_WITHIN_DAYS };
