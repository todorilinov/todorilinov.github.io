'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FakeDb, FakeBucket, png, makeCtx } = require('./fakes');
const { processSubmission, RateLimited, NotAllowed } = require('../lib/submit');
const { review, markPaid } = require('../lib/review');
const { requestCode, verifyCode, reportData, summarize, BadCode } = require('../lib/report');

const MIN = 60000;
const SID = '-Npush0000000000001';
const TOKEN = 'TOKEN1234567890abcdef';
const P = 'uploads/AbCdEfGhIjKlMnOpQr/banner.png';
const input = () => ({
  advertiser: { name: 'Ann', email: 'Ann@Acme.com', country: 'BG' }, ad: { title: 'Acme app', clickUrl: 'https://acme.com' },
  apps: { tvdsp: { banner: { path: P } } }, startDate: '2026-10-14', budget: { items: { 'tvdsp/banner': 50 } }, terms: true,
});

/** A submitted request; [paid] makes it a campaign with some statistics. */
async function setup(paid) {
  const db = new FakeDb(), bucket = new FakeBucket({ [P]: png(640, 100, 50) });
  const { ctx, mails } = makeCtx(db, bucket);
  await processSubmission(input(), ctx);
  let cid = null;
  if (paid) {
    await review({ id: SID, action: 'approve', amount: 50, paymentLink: 'https://pay.example/x' }, ctx);
    cid = (await markPaid({ id: SID }, ctx)).campaignId;
    db.write('campaigns/' + cid + '/status', 'active');
    db.write('vstats/' + cid, {
      20261011: { tvdsp: { banner: { BG: { imp: 100, clk: 4 }, RO: { imp: 40, clk: 1 } } } },
      20261010: { tvdsp: { banner: { BG: { imp: 60, clk: 2 } } }, worldradio: { mrec: { US: { imp: 7, clk: 0 } } } },
    });
    db.write('stats/' + cid, { 20261010: { tvdsp: { BG: { imp: 5000000, clk: 999 } } } });   // old counters: never shown
  }
  mails.length = 0;
  const at = ms => ({ ...ctx, now: ctx.now + ms });   // the same world, a little later
  return { db, ctx, mails, at, cid };
}
const ask = (extra = {}) => ({ id: SID, token: TOKEN, email: 'ann@acme.com', ...extra });

test('a code goes to the address of the request, whatever its capital letters, and is stored hashed', async () => {
  const { db, ctx, mails } = await setup();
  assert.deepStrictEqual(await requestCode(ask({ email: '  ANN@acme.COM ' }), ctx), { ok: true });
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'Ann@Acme.com');
  assert.match(mails[0].subject, /123456/);
  assert.match(mails[0].text, /works for 10 minutes/);
  const st = db.read('otp/' + SID);
  assert.ok(st.hash && st.salt && st.expires === ctx.now + 10 * MIN);
  assert.ok(!JSON.stringify(st).includes('123456'), 'the code itself is not stored');
});

test('another address gets the same answer and nothing is sent', async () => {
  const { db, ctx, mails } = await setup();
  assert.deepStrictEqual(await requestCode(ask({ email: 'someone@else.com' }), ctx), { ok: true });
  assert.deepStrictEqual(await requestCode(ask({ email: '' }), ctx).catch(e => e.constructor.name), 'RateLimited', 'the wait applies to this one too');
  assert.strictEqual(mails.length, 0);
  assert.strictEqual(db.read('otp/' + SID).hash, undefined);
});

test('the limits cannot be used to find out which address is registered', async () => {
  // one right and one wrong address behave the same: both are told to wait, both count toward the hourly limit
  for (const email of ['ann@acme.com', 'nobody@x.com']) {
    const { ctx, at } = await setup();
    await requestCode(ask({ email }), ctx);
    await assert.rejects(() => requestCode(ask({ email }), at(30000)), e => e instanceof RateLimited && /wait a minute/.test(e.message));
    await requestCode(ask({ email }), at(61000));
    for (let i = 2; i < 5; i++) await requestCode(ask({ email }), at(61000 * i + 1000));
    await assert.rejects(() => requestCode(ask({ email }), at(61000 * 5 + 2000)), e => e instanceof RateLimited && /too many codes/.test(e.message));
  }
});

test('a wrong link is refused', async () => {
  const { ctx } = await setup();
  await assert.rejects(() => requestCode(ask({ token: 'wrong-wrong-wrong-1' }), ctx), NotAllowed);
  await assert.rejects(() => requestCode({}, ctx), NotAllowed);
  await assert.rejects(() => requestCode(undefined, ctx), NotAllowed);
  await assert.rejects(() => verifyCode({ id: SID, token: 'wrong-wrong-wrong-1', code: '123456' }, ctx), NotAllowed);
  await assert.rejects(() => reportData({ id: SID, token: 'wrong-wrong-wrong-1', session: 'x' }, ctx), NotAllowed);
});

test('the right code opens a session; the code works only once', async () => {
  const { ctx, at } = await setup();
  await requestCode(ask(), ctx);
  const r = await verifyCode({ id: SID, token: TOKEN, code: ' 123 456 ' }, at(5 * MIN));
  assert.ok(r.session.length > 20);
  assert.strictEqual(r.expiresAt, ctx.now + 35 * MIN);
  await assert.rejects(() => verifyCode({ id: SID, token: TOKEN, code: '123456' }, at(5 * MIN)), BadCode);
});

test('a code is dead after 10 minutes', async () => {
  const { ctx, at } = await setup();
  await requestCode(ask(), ctx);
  await assert.rejects(() => verifyCode({ id: SID, token: TOKEN, code: '123456' }, at(10 * MIN + 1)), BadCode);
});

test('five wrong codes lock it, and then even the right one is refused for 15 minutes', async () => {
  const { db, ctx, at } = await setup();
  await requestCode(ask(), ctx);
  for (let i = 0; i < 5; i++) await assert.rejects(() => verifyCode({ id: SID, token: TOKEN, code: '000000' }, at(MIN)), BadCode);
  await assert.rejects(() => verifyCode({ id: SID, token: TOKEN, code: '123456' }, at(2 * MIN)), e => e instanceof RateLimited);
  await assert.rejects(() => requestCode(ask(), at(3 * MIN)), e => e instanceof RateLimited, 'no new code during the lock');
  assert.strictEqual(db.read('otp/' + SID).hash, undefined, 'the code is gone');
  // after the lock a new code can be asked for and used
  await requestCode(ask(), at(17 * MIN));
  assert.ok((await verifyCode({ id: SID, token: TOKEN, code: '123456' }, at(18 * MIN))).session);
});

test('four wrong codes and then the right one still works', async () => {
  const { ctx, at } = await setup();
  await requestCode(ask(), ctx);
  for (let i = 0; i < 4; i++) await assert.rejects(() => verifyCode({ id: SID, token: TOKEN, code: '999999' }, at(MIN)), BadCode);
  assert.ok((await verifyCode({ id: SID, token: TOKEN, code: '123456' }, at(MIN))).session);
});

test('anything that is not six digits is refused, and without a code nothing opens', async () => {
  const { ctx } = await setup();
  await requestCode(ask(), ctx);
  for (const code of ['', '12345', '1234567', 'abcdef', '12 34 5a', undefined, 123456, null]) {
    await assert.rejects(() => verifyCode({ id: SID, token: TOKEN, code }, ctx), BadCode);
  }
  const fresh = await setup();
  await assert.rejects(() => verifyCode({ id: SID, token: TOKEN, code: '123456' }, fresh.ctx), BadCode, 'no code was asked for');
});

test('the report needs a session; sessions end after 30 minutes; one request cannot use the session of another', async () => {
  const { ctx, at, db } = await setup(true);
  await assert.rejects(() => reportData({ id: SID, token: TOKEN }, ctx), e => e instanceof NotAllowed && e.code === 'unauthenticated');
  await assert.rejects(() => reportData({ id: SID, token: TOKEN, session: 'made-up-session-value' }, ctx), NotAllowed);
  await requestCode(ask(), ctx);
  const { session } = await verifyCode({ id: SID, token: TOKEN, code: '123456' }, at(MIN));
  assert.ok((await reportData({ id: SID, token: TOKEN, session }, at(20 * MIN))).hasCampaign);
  await assert.rejects(() => reportData({ id: SID, token: TOKEN, session }, at(32 * MIN)), e => e.code === 'unauthenticated');
  // the session is kept only as a hash
  assert.ok(!JSON.stringify(db.read('otp/' + SID)).includes(session));
});

test('several sessions (a phone and a laptop) work side by side', async () => {
  const { ctx, at } = await setup();
  const sessions = [];
  for (let i = 0; i < 5; i++) {
    const t = i * 2 * MIN;
    await requestCode(ask(), at(t));
    sessions.push((await verifyCode({ id: SID, token: TOKEN, code: '123456' }, at(t + 1000))).session);
  }
  assert.strictEqual(new Set(sessions).size, 5);
  for (const session of sessions) assert.ok(await reportData({ id: SID, token: TOKEN, session }, at(11 * MIN)));
});

test('the report: totals, days, countries and apps; nothing private', async () => {
  const { ctx, at } = await setup(true);
  await requestCode(ask(), ctx);
  const { session } = await verifyCode({ id: SID, token: TOKEN, code: '123456' }, at(MIN));
  const r = await reportData({ id: SID, token: TOKEN, session }, at(2 * MIN));
  assert.strictEqual(r.status, 'active');
  assert.strictEqual(r.hasCampaign, true);
  assert.strictEqual(r.delivered, 207);
  assert.deepStrictEqual(r.totals, { imp: 207, clk: 7 });
  assert.deepStrictEqual(r.byDay, [{ day: '20261010', imp: 67, clk: 2 }, { day: '20261011', imp: 140, clk: 5 }]);
  assert.deepStrictEqual(r.byCountry.map(x => x.cc + ':' + x.imp), ['BG:160', 'RO:40', 'US:7']);
  assert.deepStrictEqual(r.byApp.map(x => x.name + ':' + x.imp), ['TV DSP Center:200', 'worldradio:7'].map(x => x.replace('worldradio', 'WorldRadio')));
  assert.deepStrictEqual(r.budget, { target: 41600, amount: 50, currency: 'EUR' });
  assert.deepStrictEqual(r.byFormat, [{ app: 'worldradio', slot: 'mrec', name: 'WorldRadio', label: 'Medium rectangle', imp: 7, clk: 0 },
    { app: 'tvdsp', slot: 'banner', name: 'TV DSP Center', label: 'Banner', imp: 200, clk: 7, target: 41600 }].sort((a, b) => ['worldradio', 'tvdsp', 'fakelocation'].indexOf(a.app) - ['worldradio', 'tvdsp', 'fakelocation'].indexOf(b.app)));
  const json = JSON.stringify(r);
  for (const secret of ['ann@acme.com', 'Ann@Acme.com', 'ipHash', TOKEN, 'tokenHash', 'salt', session]) assert.ok(!json.includes(secret), secret + ' leaked');
});

test('before the campaign exists there is a report without numbers', async () => {
  const { ctx, at } = await setup(false);
  await requestCode(ask(), ctx);
  const { session } = await verifyCode({ id: SID, token: TOKEN, code: '123456' }, at(MIN));
  const r = await reportData({ id: SID, token: TOKEN, session }, at(2 * MIN));
  assert.strictEqual(r.hasCampaign, false);
  assert.strictEqual(r.byDay, undefined);
  assert.strictEqual(r.status, 'pending');
});

test('summarize copes with missing and odd data', () => {
  assert.deepStrictEqual(summarize(null).totals, { imp: 0, clk: 0 });
  const s = summarize({ 20261010: { tvdsp: { banner: { BG: { imp: '5', clk: 'x' }, RO: null } } }, 20261011: null });
  assert.deepStrictEqual(s.totals, { imp: 5, clk: 0 });
  // a format that was paid for and has shown nothing yet is still listed, with its target
  const t = summarize(null, { tvdsp: { banner: { amount: 50, cpm: 1.2, impressions: 41600 } } });
  assert.deepStrictEqual(t.byFormat, [{ app: 'tvdsp', slot: 'banner', name: 'TV DSP Center', label: 'Banner', imp: 0, clk: 0, target: 41600 }]);
});
