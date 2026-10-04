'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FakeDb, FakeBucket, png, gif, makeCtx } = require('./fakes');
const { processSubmission, processResubmission, InvalidRequest, RateLimited, NotAllowed, tokenOk } = require('../lib/submit');
const { review, markPaid, expireUnpaid, statusGet, ReviewError } = require('../lib/review');

const DAY = 86400000;
const NOW = Date.parse('2026-10-10T12:00:00Z');
const TOKEN = 'TOKEN1234567890abcdef';
const SID = '-Npush0000000000001';

const input = (over = {}) => ({
  advertiser: { name: 'Ann', company: 'Acme', email: 'ann@acme.com', country: 'BG' },
  ad: { title: 'Acme app', description: 'Try it', clickUrl: 'https://acme.com/x' },
  apps: { tvdsp: { banner: { path: 'uploads/AbCdEfGhIjKlMnOpQr/banner.png' } } },
  countries: ['BG'],
  startDate: '2026-10-14',
  budget: { items: { 'tvdsp/banner': 50 } },
  terms: true,
  ...over,
});

/** A request that has just been submitted. */
async function submitted(over) {
  const db = new FakeDb(), bucket = new FakeBucket({
    'uploads/AbCdEfGhIjKlMnOpQr/banner.png': png(640, 100, 500),
  });
  const { ctx, mails } = makeCtx(db, bucket);
  await processSubmission(input(over), ctx);
  mails.length = 0;
  return { db, bucket, ctx, mails };
}
const approve = { id: SID, action: 'approve', amount: 120.456, paymentLink: 'https://pay.example/abc', note: 'Includes VAT' };

// ── review ──────────────────────────────────────────────────────────────────
test('approve sets the price, the payment link and a 14 day limit, and tells the advertiser', async () => {
  const { db, ctx, mails } = await submitted();
  const r = await review(approve, ctx);
  assert.strictEqual(r.status, 'approved');
  const rec = db.read('submissions/' + SID);
  assert.strictEqual(rec.status, 'approved');
  assert.deepStrictEqual(rec.final, { amount: 120.46, currency: 'EUR', note: 'Includes VAT' });
  assert.strictEqual(rec.payment.link, 'https://pay.example/abc');
  assert.strictEqual(rec.payBy, NOW + 14 * DAY);
  assert.strictEqual(Object.values(rec.log).at(-1).to, 'approved');
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'ann@acme.com');
  assert.match(mails[0].subject, /approved/);
  assert.match(mails[0].text, /120\.46 EUR for 41,600 impressions/);
  assert.match(mails[0].text, /ad-status\.html\?i=-Npush0000000000001&t=TOKEN1234567890abcdef/);
  assert.match(mails[0].text, /2026-10-24/);
});

test('approve needs a price and an https payment link', async () => {
  const { ctx } = await submitted();
  await assert.rejects(() => review({ ...approve, amount: 0 }, ctx), ReviewError);
  await assert.rejects(() => review({ ...approve, amount: 'abc' }, ctx), ReviewError);
  await assert.rejects(() => review({ ...approve, paymentLink: 'http://pay.example' }, ctx), ReviewError);
  await assert.rejects(() => review({ ...approve, paymentLink: 'javascript:alert(1)' }, ctx), ReviewError);
  await assert.rejects(() => review({ ...approve, paymentLink: 'https://a b' }, ctx), ReviewError);
});

test('reject and changes need a text the advertiser can read', async () => {
  const { db, ctx, mails } = await submitted();
  await assert.rejects(() => review({ id: SID, action: 'reject', note: '' }, ctx), ReviewError);
  await assert.rejects(() => review({ id: SID, action: 'changes', note: 'x' }, ctx), ReviewError);
  await review({ id: SID, action: 'changes', note: 'The banner is blurry.' }, ctx);
  let rec = db.read('submissions/' + SID);
  assert.strictEqual(rec.status, 'changes_requested');
  assert.strictEqual(rec.review.note, 'The banner is blurry.');
  assert.match(mails.at(-1).text, /The banner is blurry\./);
  // after changes the advertiser must resubmit first
  await assert.rejects(() => review(approve, ctx), e => e.code === 'failed-precondition');
});

test('reject is possible before and after approval, and clears the payment', async () => {
  const { db, ctx, mails } = await submitted();
  await review(approve, ctx);
  await review({ id: SID, action: 'reject', note: 'Misleading claim.' }, ctx);
  const rec = db.read('submissions/' + SID);
  assert.strictEqual(rec.status, 'rejected');
  assert.strictEqual(rec.review.rejectReason, 'Misleading claim.');
  assert.strictEqual(rec.payment, undefined);
  assert.strictEqual(rec.payBy, undefined);
  assert.match(mails.at(-1).text, /Misleading claim\./);
});

test('unknown request or action', async () => {
  const { ctx } = await submitted();
  await assert.rejects(() => review({ ...approve, id: '-Nnope000000000000' }, ctx), e => e.code === 'not-found');
  await assert.rejects(() => review({ ...approve, id: '../x' }, ctx), e => e.code === 'not-found');
  await assert.rejects(() => review({ id: SID, action: 'delete' }, ctx), ReviewError);
});

// ── payment ─────────────────────────────────────────────────────────────────
test('mark as paid copies the files, creates a PAUSED campaign and tells the advertiser', async () => {
  const { db, bucket, ctx, mails } = await submitted();
  await review(approve, ctx);
  mails.length = 0;
  const r = await markPaid({ id: SID, reference: 'PP-123' }, ctx);
  const cid = r.campaignId;
  const c = db.read('campaigns/' + cid);
  assert.strictEqual(c.status, 'paused', 'a person switches it on');
  assert.strictEqual(c.kind, 'paid');
  assert.strictEqual(c.weight, 20);
  assert.deepStrictEqual(c.cap, { n: 3, per: 'hour' });
  assert.strictEqual(c.title, 'Acme app');
  assert.deepStrictEqual(c.countries, ['BG']);
  assert.strictEqual(c.from, Date.parse('2026-10-14T00:00:00Z'));
  assert.strictEqual(c.submissionId, SID);
  assert.deepStrictEqual(c.budget, { model: 'impressions', amount: 50, currency: 'EUR', target: 41600, items: { tvdsp: { banner: { amount: 50, cpm: 1.2, impressions: 41600 } } } });
  assert.strictEqual(c.delivered, 0);
  const cr = c.slots.tvdsp.banner;
  assert.strictEqual(cr.type, 'image');
  assert.match(cr.path, new RegExp('^creatives/' + cid + '/tvdsp_banner_\\d+\\.png$'));
  assert.ok(cr.url.startsWith('https://firebasestorage.googleapis.com/v0/b/test-bucket/o/creatives%2F' + cid), cr.url);
  assert.ok(cr.url.endsWith('?alt=media'));
  assert.strictEqual(cr.w, 640);
  assert.ok(bucket.files.has(cr.path), 'the file was copied');
  assert.ok(bucket.files.has('submissions/' + SID + '/tvdsp_banner.png'), 'the original stays');
  const rec = db.read('submissions/' + SID);
  assert.strictEqual(rec.status, 'paid');
  assert.strictEqual(rec.campaignId, cid);
  assert.strictEqual(rec.payment.ref, 'PP-123');
  assert.ok(rec.payment.paidAt);
  assert.strictEqual(mails.length, 1);
  assert.match(mails[0].subject, /Payment received/);
  assert.match(mails[0].text, /120\.46 EUR/);
});

test('mark as paid twice does not create two campaigns; unapproved cannot be paid', async () => {
  const { db, ctx } = await submitted();
  await assert.rejects(() => markPaid({ id: SID }, ctx), e => e.code === 'failed-precondition');
  await review(approve, ctx);
  const a = await markPaid({ id: SID }, ctx);
  const b = await markPaid({ id: SID }, ctx);
  assert.strictEqual(b.campaignId, a.campaignId);
  assert.strictEqual(b.already, true);
  assert.strictEqual(Object.keys(db.read('campaigns')).length, 1);
});

// ── expiry ──────────────────────────────────────────────────────────────────
test('an approval nobody paid expires after 14 days, a fresh one does not', async () => {
  const { db, ctx, mails } = await submitted();
  await review(approve, ctx);
  mails.length = 0;
  assert.strictEqual(await expireUnpaid({ ...ctx, now: NOW + 13 * DAY }), 0);
  assert.strictEqual(await expireUnpaid({ ...ctx, now: NOW + 15 * DAY }), 1);
  const rec = db.read('submissions/' + SID);
  assert.strictEqual(rec.status, 'expired');
  assert.strictEqual(rec.payment, undefined);
  assert.match(mails[0].subject, /expired/);
  assert.strictEqual(await expireUnpaid({ ...ctx, now: NOW + 20 * DAY }), 0);
});

// ── what the advertiser sees ────────────────────────────────────────────────
test('status needs the right id and token', async () => {
  const { db, ctx } = await submitted();
  assert.strictEqual(await tokenOk(db, SID, TOKEN), true);
  assert.strictEqual(await tokenOk(db, SID, 'TOKEN1234567890abcdeX'), false);
  assert.strictEqual(await tokenOk(db, '-Npush0000000000002', TOKEN), false);
  assert.strictEqual(await tokenOk(db, SID, ''), false);
  assert.strictEqual(await tokenOk(db, SID, undefined), false);
  await assert.rejects(() => statusGet({ id: SID, token: 'wrong-wrong-wrong-1' }, ctx), NotAllowed);
});

test('the status view shows state and price, never the email address or internals', async () => {
  const { db, ctx } = await submitted();
  let v = await statusGet({ id: SID, token: TOKEN }, ctx);
  assert.strictEqual(v.status, 'pending');
  assert.strictEqual(v.payLink, undefined);
  await review(approve, ctx);
  v = await statusGet({ id: SID, token: TOKEN }, ctx);
  assert.strictEqual(v.status, 'approved');
  assert.deepStrictEqual(v.final, { amount: 120.46, currency: 'EUR', note: 'Includes VAT' });
  assert.strictEqual(v.payLink, 'https://pay.example/abc');
  assert.ok(v.payBy);
  const json = JSON.stringify(v);
  for (const secret of ['ann@acme.com', 'ipHash', TOKEN, 'tokenHash', 'Acme"']) assert.ok(!json.includes(secret), secret + ' leaked');
  assert.deepStrictEqual(v.apps, [{ app: 'tvdsp', name: 'TV DSP Center', slots: [{ slot: 'banner', label: 'Banner' }] }]);
});

test('after payment the status follows the campaign', async () => {
  const { db, ctx } = await submitted();
  await review(approve, ctx);
  const { campaignId } = await markPaid({ id: SID }, ctx);
  let v = await statusGet({ id: SID, token: TOKEN }, ctx);
  assert.strictEqual(v.status, 'paid');
  assert.strictEqual(v.payLink, undefined, 'no pay button after paying');
  db.write('campaigns/' + campaignId + '/status', 'active');
  assert.strictEqual((await statusGet({ id: SID, token: TOKEN }, ctx)).status, 'active');
  db.write('campaigns/' + campaignId + '/status', 'finished');
  assert.strictEqual((await statusGet({ id: SID, token: TOKEN }, ctx)).status, 'finished');
});

test('the note to the advertiser is shown for changes_requested, not for others', async () => {
  const { ctx } = await submitted();
  await review({ id: SID, action: 'changes', note: 'Please use a sharper banner.' }, ctx);
  const v = await statusGet({ id: SID, token: TOKEN }, ctx);
  assert.strictEqual(v.status, 'changes_requested');
  assert.strictEqual(v.review.note, 'Please use a sharper banner.');
  assert.strictEqual(v.canChange, true);
});

test('too many status requests from one address are refused', async () => {
  const { ctx } = await submitted();
  for (let i = 0; i < 120; i++) await statusGet({ id: SID, token: TOKEN }, ctx);
  await assert.rejects(() => statusGet({ id: SID, token: TOKEN }, ctx), RateLimited);
});

// ── a new version ───────────────────────────────────────────────────────────
const newVersion = (over = {}) => ({
  id: SID, token: TOKEN,
  ad: { title: 'Acme app 2', description: '', clickUrl: 'https://acme.com/new' },
  apps: { tvdsp: { banner: { path: 'uploads/ZyXwVuTsRqPoNmLkJi/banner.gif' } } },
  countries: [], startDate: '2026-10-20', budget: { items: { 'tvdsp/banner': 120 } }, terms: true, ...over,
});

test('the advertiser can send a new version after changes were requested', async () => {
  const { db, bucket, ctx, mails } = await submitted();
  await review({ id: SID, action: 'changes', note: 'Use a GIF.' }, ctx);
  mails.length = 0;
  bucket.files.set('uploads/ZyXwVuTsRqPoNmLkJi/banner.gif', gif(640, 100));
  const r = await processResubmission(newVersion(), ctx);
  assert.strictEqual(r.ok, true);
  const rec = db.read('submissions/' + SID);
  assert.strictEqual(rec.status, 'pending');
  assert.strictEqual(rec.title, 'Acme app 2');
  assert.strictEqual(rec.review, undefined, 'the old note is gone');
  assert.strictEqual(rec.description, undefined);
  assert.strictEqual(rec.countries, undefined);
  assert.strictEqual(rec.budget.target, 100000);
  assert.strictEqual(rec.budget.amount, 120);
  assert.strictEqual(rec.advertiser.email, 'ann@acme.com', 'who the advertiser is cannot be changed');
  assert.strictEqual(rec.slots.tvdsp.banner.type, 'gif');
  assert.ok(bucket.files.has('submissions/' + SID + '/tvdsp_banner.gif'));
  assert.ok(!bucket.files.has('submissions/' + SID + '/tvdsp_banner.png'), 'the old file is deleted');
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'admin@x.dev');
  assert.match(mails[0].subject, /Updated ad request/);
  assert.strictEqual(Object.values(rec.log).at(-1).to, 'pending');
});

test('a new version is refused with a wrong token, or while the request is not sent back', async () => {
  const { bucket, ctx } = await submitted();
  bucket.files.set('uploads/ZyXwVuTsRqPoNmLkJi/banner.gif', gif(640, 100));
  await assert.rejects(() => processResubmission(newVersion({ token: 'wrong-wrong-wrong-1' }), ctx), NotAllowed);
  await assert.rejects(() => processResubmission(newVersion(), ctx), e => e instanceof NotAllowed && e.code === 'failed-precondition');
  await review(approve, ctx);
  await assert.rejects(() => processResubmission(newVersion(), ctx), e => e.code === 'failed-precondition');
});

test('a rejected request can be sent again, and the new files are checked like the first time', async () => {
  const { ctx, bucket, db } = await submitted();
  await review({ id: SID, action: 'reject', note: 'Not suitable.' }, ctx);
  bucket.files.set('uploads/ZyXwVuTsRqPoNmLkJi/banner.gif', gif(300, 100));
  await assert.rejects(() => processResubmission(newVersion(), ctx), e => e instanceof InvalidRequest && /exactly 640×100/.test(e.errors[0].msg));
  assert.strictEqual(db.read('submissions/' + SID).status, 'rejected', 'nothing changed');
  bucket.files.set('uploads/ZyXwVuTsRqPoNmLkJi/banner.gif', gif(640, 100));
  await processResubmission(newVersion(), ctx);
  assert.strictEqual(db.read('submissions/' + SID).status, 'pending');
});

test('an empty or broken call is refused cleanly, not with a crash', async () => {
  const { ctx } = await submitted();
  await assert.rejects(() => processResubmission(undefined, ctx), NotAllowed);
  await assert.rejects(() => processResubmission({}, ctx), NotAllowed);
  await assert.rejects(() => statusGet(undefined, ctx), NotAllowed);
  await assert.rejects(() => review({}, ctx), ReviewError);
  await assert.rejects(() => markPaid({}, ctx), ReviewError);
});
