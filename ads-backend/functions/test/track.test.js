'use strict';
const test = require('node:test');
const assert = require('node:assert');
const jose = require('jose');
const { FakeDb, FakeBucket, makeCtx } = require('./fakes');
const { ingest, parse, TrackError, LIMITS } = require('../lib/track');
const { verifyAppCheck, APP_PROJECTS } = require('../lib/appcheck');
const { RateLimited } = require('../lib/submit');

const CID = '-Ncamp00000000000001';
const HOUSE = '-Nhouse0000000000002';
const campaigns = { [CID]: { slots: { tvdsp: { banner: true }, worldradio: { banner: true, fullscreen: true } } }, [HOUSE]: { slots: { tvdsp: { banner: true } } } };

function setup(over = {}) {
  const db = new FakeDb();
  const { ctx } = makeCtx(db, new FakeBucket(), {
    increment: n => ({ '.sv': { increment: n } }),
    campaigns: async () => campaigns,
    verifyAppCheck: async t => t === 'good-token',
    requireAppCheck: false,
    ...over,
  });
  return { db, ctx, at: ms => ({ ...ctx, now: ctx.now + ms }) };
}
let n = 0;
const batch = (extra = {}) => ({ v: 1, app: 'tvdsp', bid: 'batch-' + String(++n).padStart(12, '0'), events: [{ c: CID, s: 'banner', cc: 'BG', imp: 3, clk: 1 }], ...extra });
const DAY = '20261010';

test('impressions, clicks and ad requests are added up under the server\'s day', async () => {
  const { db, ctx } = setup();
  const r = await ingest(batch({ opp: [{ s: 'banner', cc: 'BG', n: 12 }, { s: 'banner', cc: 'RO', n: 5 }] }), undefined, ctx);
  assert.deepStrictEqual(r, { ok: true, imp: 3, clk: 1, opp: 17 });
  assert.deepStrictEqual(db.read('vstats/' + CID + '/' + DAY + '/tvdsp/banner/BG'), { imp: 3, clk: 1 });
  assert.deepStrictEqual(db.read('inventory/' + DAY + '/tvdsp/banner'), { BG: 12, RO: 5 });
  await ingest(batch({ events: [{ c: CID, s: 'banner', cc: 'BG', imp: 2 }, { c: CID, s: 'banner', cc: 'BG', imp: 5, clk: 2 }] }), undefined, ctx);
  assert.deepStrictEqual(db.read('vstats/' + CID + '/' + DAY + '/tvdsp/banner/BG'), { imp: 10, clk: 3 }, 'two events and an earlier batch add up');
});

test('the same batch twice is counted once', async () => {
  const { db, ctx } = setup();
  const b = batch();
  await ingest(b, undefined, ctx);
  const again = await ingest(b, undefined, ctx);
  assert.strictEqual(again.duplicate, true);
  assert.strictEqual(db.read('vstats/' + CID + '/' + DAY + '/tvdsp/banner/BG/imp'), 3);
});

test('what does not belong to a campaign of the app and format is dropped, not refused', async () => {
  const { db, ctx } = setup();
  const r = await ingest(batch({ app: 'worldradio', events: [
    { c: '-Nnothere00000000009', s: 'banner', cc: 'BG', imp: 5 },       // no such campaign
    { c: CID, s: 'mrec', cc: 'BG', imp: 5 },                             // the campaign has no medium rectangle file
  ] }), undefined, ctx);
  assert.deepStrictEqual(r, { ok: true, imp: 0, clk: 0, opp: 0 });
  assert.strictEqual(db.read('vstats'), undefined);
  // the format exists for WorldRadio but this campaign has no file for it in TV DSP Center
  const r2 = await ingest(batch({ app: 'worldradio', events: [{ c: CID, s: 'fullscreen', cc: 'BG', imp: 2 }, { c: HOUSE, s: 'banner', cc: 'BG', imp: 2 }] }), undefined, ctx);
  assert.strictEqual(r2.imp, 2, 'only the campaign that has that format in that app');
});

test('a badly shaped batch is refused with 400', () => {
  const bads = [
    null, 'x', { ...batch(), v: 2 }, { ...batch(), app: 'nope' }, { ...batch(), bid: 'short' }, { ...batch(), bid: 'has spaces and is long enough' },
    { ...batch(), events: 'x' }, { ...batch(), events: Array(61).fill({ c: CID, s: 'banner', cc: 'BG', imp: 1 }) },
    { ...batch(), events: [{ c: 'abc', s: 'banner', cc: 'BG', imp: 1 }] },
    { ...batch(), events: [{ c: CID, s: 'fullscreen', cc: 'BG', imp: 1 }] },            // TV DSP Center has only a banner
    { ...batch(), events: [{ c: CID, s: 'banner', cc: 'bg', imp: 1 }] },
    { ...batch(), events: [{ c: CID, s: 'banner', cc: 'BGR', imp: 1 }] },
    { ...batch(), events: [{ c: CID, s: 'banner', cc: 'BG', imp: 101 }] },
    { ...batch(), events: [{ c: CID, s: 'banner', cc: 'BG', imp: -1 }] },
    { ...batch(), events: [{ c: CID, s: 'banner', cc: 'BG', imp: 1.5 }] },
    { ...batch(), events: [{ c: CID, s: 'banner', cc: 'BG', imp: '3' }] },
    { ...batch(), events: [{ c: CID, s: 'banner', cc: 'BG', clk: 1e9 }] },
    { ...batch(), opp: [{ s: 'banner', cc: 'BG', n: 5001 }] },
    { ...batch(), opp: [{ s: 'x', cc: 'BG', n: 1 }] },
    { ...batch(), opp: Array(31).fill({ s: 'banner', cc: 'BG', n: 1 }) },
  ];
  for (const b of bads) assert.throws(() => parse(b), e => e instanceof TrackError && e.status === 400, JSON.stringify(b).slice(0, 80));
  assert.doesNotThrow(() => parse(batch()));
  assert.doesNotThrow(() => parse({ v: 1, app: 'tvdsp', bid: 'batch-with-only-opp-1' , opp: [{ s: 'banner', cc: 'ZZ', n: 1 }] }));
});

test('when App Check is required, only a valid token gets through', async () => {
  const { db, ctx } = setup({ requireAppCheck: true });
  await assert.rejects(() => ingest(batch(), undefined, ctx), e => e.status === 403);
  await assert.rejects(() => ingest(batch(), 'forged', ctx), e => e.status === 403);
  assert.strictEqual(db.read('vstats'), undefined);
  assert.strictEqual((await ingest(batch(), 'good-token', ctx)).imp, 3);
});

test('the token is checked against the app that sends: a valid token of another app is not enough', async () => {
  const { ctx } = setup({ requireAppCheck: true, verifyAppCheck: async (t, app) => t === 'worldradio-token' && app === 'worldradio' });
  await assert.rejects(() => ingest(batch({ app: 'tvdsp' }), 'worldradio-token', ctx), e => e.status === 403);
  assert.ok(await ingest(batch({ app: 'worldradio', events: [{ c: CID, s: 'banner', cc: 'BG', imp: 1 }] }), 'worldradio-token', ctx));
});

test('while App Check is not required, a missing token passes (to try the chain first)', async () => {
  const { ctx } = setup({ requireAppCheck: false });
  assert.strictEqual((await ingest(batch(), undefined, ctx)).imp, 3);
});

test('limits per address and hour: requests, impressions, clicks, ad requests', async () => {
  let s = setup();
  for (let i = 0; i < LIMITS.requests; i++) await ingest(batch({ events: [] }), undefined, s.ctx);
  await assert.rejects(() => ingest(batch({ events: [] }), undefined, s.ctx), e => e.status === 429);
  await ingest(batch({ events: [] }), undefined, s.at(61 * 60000));   // the next hour is open again

  s = setup();
  const big = () => batch({ events: Array.from({ length: 10 }, () => ({ c: CID, s: 'banner', cc: 'BG', imp: 60 })) });   // 600 at once
  assert.strictEqual((await ingest(big(), undefined, s.ctx)).imp, 600);
  const before = JSON.stringify(s.db.read('vstats'));
  await assert.rejects(() => ingest(batch(), undefined, s.ctx), e => e.status === 429 && /impressions/.test(e.message));
  assert.strictEqual(JSON.stringify(s.db.read('vstats')), before, 'a refused batch writes nothing');

  s = setup();
  await ingest(batch({ events: [{ c: CID, s: 'banner', cc: 'BG', clk: 60 }] }), undefined, s.ctx);
  await assert.rejects(() => ingest(batch({ events: [{ c: CID, s: 'banner', cc: 'BG', clk: 1 }] }), undefined, s.ctx), e => e.status === 429 && /clicks/.test(e.message));

  s = setup();
  for (let i = 0; i < 5; i++) await ingest(batch({ events: [], opp: [{ s: 'banner', cc: 'BG', n: 1000 }] }), undefined, s.ctx);
  await assert.rejects(() => ingest(batch({ events: [], opp: [{ s: 'banner', cc: 'BG', n: 1 }] }), undefined, s.ctx), e => e.status === 429);
});

test('another address has its own allowance', async () => {
  const s = setup();
  for (let i = 0; i < LIMITS.requests; i++) await ingest(batch({ events: [] }), undefined, s.ctx);
  assert.ok(await ingest(batch({ events: [] }), undefined, { ...s.ctx, ip: '9.9.9.9' }));
});

// ── App Check tokens ────────────────────────────────────────────────────────
async function token(project, { key, exp = '1h', iss, aud, sub = '1:311173752553:android:abc' } = {}) {
  const { publicKey, privateKey } = key || await jose.generateKeyPair('RS256');
  const jwt = await new jose.SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'k1' })
    .setIssuer(iss || 'https://firebaseappcheck.googleapis.com/' + project)
    .setAudience(aud || ['projects/' + project, 'projects/some-id'])
    .setSubject(sub).setIssuedAt().setExpirationTime(exp).sign(privateKey);
  return { jwt, publicKey };
}
const keysFor = async publicKey => jose.createLocalJWKSet({ keys: [{ ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });

test('App Check: a genuine token of the app\'s own project is accepted', async () => {
  const { jwt, publicKey } = await token(APP_PROJECTS.tvdsp);
  assert.strictEqual(await verifyAppCheck(jwt, 'tvdsp', await keysFor(publicKey)), true);
});

test('App Check: a token of another project, another app, a wrong key, an old token or garbage is not', async () => {
  const good = await token(APP_PROJECTS.tvdsp);
  const keys = await keysFor(good.publicKey);
  assert.strictEqual(await verifyAppCheck(good.jwt, 'worldradio', keys), false, 'valid, but for another app');
  assert.strictEqual(await verifyAppCheck(good.jwt, 'nope', keys), false);
  const other = await token(APP_PROJECTS.worldradio);
  assert.strictEqual(await verifyAppCheck(other.jwt, 'tvdsp', await keysFor(other.publicKey)), false, 'issued by the WorldRadio project');
  const forged = await token(APP_PROJECTS.tvdsp);           // right claims, signed with a key Google does not publish
  assert.strictEqual(await verifyAppCheck(forged.jwt, 'tvdsp', keys), false);
  const expired = await token(APP_PROJECTS.tvdsp, { exp: Math.floor(Date.now() / 1000) - 60 });
  assert.strictEqual(await verifyAppCheck(expired.jwt, 'tvdsp', await keysFor(expired.publicKey)), false);
  const wrongAud = await token(APP_PROJECTS.tvdsp, { aud: ['projects/999'] });
  assert.strictEqual(await verifyAppCheck(wrongAud.jwt, 'tvdsp', await keysFor(wrongAud.publicKey)), false);
  const noSub = await token(APP_PROJECTS.tvdsp, { sub: '' });
  assert.strictEqual(await verifyAppCheck(noSub.jwt, 'tvdsp', await keysFor(noSub.publicKey)), false);
  for (const junk of ['', 'abc', 'a.b.c', undefined, null, 5, 'x'.repeat(5000)]) assert.strictEqual(await verifyAppCheck(junk, 'tvdsp', keys), false);
});
