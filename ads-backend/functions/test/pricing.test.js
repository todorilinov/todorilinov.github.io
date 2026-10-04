'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_PRICING, normalizePricing, impressionsFor } = require('../lib/pricing');
const { validateInput } = require('../lib/spec');
const { FakeDb, FakeBucket, png, makeCtx } = require('./fakes');
const { processSubmission } = require('../lib/submit');
const { deliveryCheck, sumImpressions } = require('../lib/delivery');
const { review, markPaid } = require('../lib/review');

const NOW = Date.parse('2026-10-10T12:00:00Z');
const P = 'uploads/AbCdEfGhIjKlMnOpQr/banner.png';
const base = (items, apps) => ({
  advertiser: { name: 'Ann', email: 'ann@acme.com', country: 'BG' },
  ad: { title: 'T', clickUrl: 'https://acme.com' },
  apps: apps || { tvdsp: { banner: { path: P } } },
  startDate: '2026-10-14', terms: true, budget: { items },
});
const fields = (input, pricing) => validateInput(input, NOW, pricing).errors.map(e => e.field + ': ' + e.msg);

test('impressions: amount / price per 1000, rounded down to hundreds', () => {
  assert.strictEqual(impressionsFor(50, 1.2), 41600);
  assert.strictEqual(impressionsFor(10, 1), 10000);
  assert.strictEqual(impressionsFor(100, 10), 10000);
  assert.strictEqual(impressionsFor(25, 3), 8300);
});

test('a broken price list becomes a complete, valid one', () => {
  for (const junk of [null, undefined, 5, 'x', [], { items: 'no' }, { items: { tvdsp: { banner: { cpm: -4, on: 'yes' } } }, minBudget: 'abc', presets: 'x' }]) {
    const p = normalizePricing(junk);
    assert.strictEqual(p.currency, 'EUR');
    assert.ok(p.minBudget >= 1 && p.maxBudget >= p.minBudget);
    assert.ok(p.presets.length > 0);
    for (const [a, slots] of Object.entries({ worldradio: 3, tvdsp: 1, fakelocation: 1 })) assert.strictEqual(Object.keys(p.items[a]).length, slots);
    for (const m of Object.values(p.items)) for (const it of Object.values(m)) assert.ok(it.cpm >= 0.01 && typeof it.on === 'boolean');
  }
  assert.deepStrictEqual(normalizePricing(null), normalizePricing(DEFAULT_PRICING));
});

test('the admin can change prices, minimum and which formats are on', () => {
  const p = normalizePricing({ minBudget: 20, items: { tvdsp: { banner: { cpm: 4 } }, worldradio: { fullscreen: { on: false } } }, presets: [5, 20, 100, 100, 99999] });
  assert.strictEqual(p.items.tvdsp.banner.cpm, 4);
  assert.strictEqual(p.items.worldradio.fullscreen.on, false);
  assert.strictEqual(p.items.worldradio.banner.cpm, 1.5, 'the rest keeps the default');
  assert.deepStrictEqual(p.presets, [20, 100], 'presets outside the limits and duplicates are dropped');
});

test('every format with a file needs a budget between the limits', () => {
  assert.deepStrictEqual(fields(base({ 'tvdsp/banner': 50 })), []);
  assert.match(fields(base({}))[0], /budget:tvdsp\/banner: Enter a budget/);
  assert.match(fields(base({ 'tvdsp/banner': 'abc' }))[0], /Enter a budget/);
  assert.match(fields(base({ 'tvdsp/banner': 5 }))[0], /minimum budget is 10 EUR/);
  assert.match(fields(base({ 'tvdsp/banner': 99999 }))[0], /maximum budget is 5000 EUR/);
  assert.match(fields(base({ 'tvdsp/banner': -50 }))[0], /minimum/);
});

test('the amounts add up, per format, from the price list', () => {
  const pricing = normalizePricing({ items: { worldradio: { banner: { cpm: 2 }, fullscreen: { cpm: 10 } } } });
  const input = base({ 'worldradio/banner': 40, 'worldradio/fullscreen': 30.456 },
    { worldradio: { banner: { path: P }, fullscreen: { path: 'uploads/AbCdEfGhIjKlMnOpQr/fullscreen.mp4' } } });
  const { errors, value } = validateInput(input, NOW, pricing);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(value.budget.items.worldradio, { banner: { amount: 40, cpm: 2, impressions: 20000 }, fullscreen: { amount: 30.46, cpm: 10, impressions: 3000 } });
  assert.strictEqual(value.budget.amount, 70.46);
  assert.strictEqual(value.budget.target, 23000);
});

test('a switched-off format cannot be bought', () => {
  const pricing = normalizePricing({ items: { tvdsp: { banner: { on: false } } } });
  assert.match(fields(base({ 'tvdsp/banner': 50 }), pricing)[0], /not available right now/);
});

test('numbers for impressions or prices sent by the browser are ignored', () => {
  const input = base({ 'tvdsp/banner': 50 });
  input.budget.target = 99999999; input.budget.impressions = 99999999; input.budget.cpm = 0.0001;
  input.budget.items['tvdsp/banner'] = 50;
  const { value } = validateInput(input, NOW);
  assert.strictEqual(value.budget.target, 41600);
  assert.strictEqual(value.budget.items.tvdsp.banner.cpm, 1.2);
});

test('the server uses the saved price list, and the price is locked in the request', async () => {
  const db = new FakeDb({ pricing: { items: { tvdsp: { banner: { cpm: 5 } } } } });
  const { ctx } = makeCtx(db, new FakeBucket({ [P]: png(640, 100) }));
  await processSubmission({ ...base({ 'tvdsp/banner': 50 }), startDate: '2026-10-14' }, ctx);
  const rec = db.read('submissions/-Npush0000000000001');
  assert.deepStrictEqual(rec.budget.items.tvdsp.banner, { amount: 50, cpm: 5, impressions: 10000 });
  db.write('pricing/items/tvdsp/banner/cpm', 50);   // a later price change does not touch it
  assert.strictEqual(db.read('submissions/-Npush0000000000001').budget.target, 10000);
});

// ── delivery ────────────────────────────────────────────────────────────────
test('sumImpressions adds every day, app and country', () => {
  assert.strictEqual(sumImpressions({ 20261010: { tvdsp: { BG: { imp: 10, clk: 1 }, RO: { imp: 5 } } }, 20261011: { worldradio: { US: { imp: 7 } } } }), 22);
  assert.strictEqual(sumImpressions(null), 0);
});

async function paidCampaign(items) {
  const db = new FakeDb(), bucket = new FakeBucket({ [P]: png(640, 100, 100) });
  const { ctx, mails } = makeCtx(db, bucket);
  await processSubmission(base(items || { 'tvdsp/banner': 50 }), ctx);
  await review({ id: '-Npush0000000000001', action: 'approve', amount: 50, paymentLink: 'https://pay.example/x' }, ctx);
  const { campaignId } = await markPaid({ id: '-Npush0000000000001' }, ctx);
  mails.length = 0;
  return { db, ctx, mails, cid: campaignId };
}

test('a paid campaign finishes by itself when everything paid for was shown', async () => {
  const { db, ctx, mails, cid } = await paidCampaign();
  assert.deepStrictEqual(await deliveryCheck(ctx), { checked: 0, finished: 0 }, 'a paused campaign is not counted');
  db.write('campaigns/' + cid + '/status', 'active');
  db.write('stats/' + cid + '/20261010/tvdsp/BG', { imp: 10000, clk: 30 });
  assert.deepStrictEqual(await deliveryCheck(ctx), { checked: 1, finished: 0 });
  assert.strictEqual(db.read('campaigns/' + cid).delivered, 10000);
  assert.strictEqual(db.read('campaigns/' + cid).status, 'active');
  db.write('stats/' + cid + '/20261011/tvdsp/RO', { imp: 31500 });
  assert.deepStrictEqual(await deliveryCheck(ctx), { checked: 1, finished: 0 }, '41,500 of 41,600: not yet');
  db.write('stats/' + cid + '/20261011/tvdsp/RO', { imp: 31600 });
  assert.deepStrictEqual(await deliveryCheck(ctx), { checked: 1, finished: 1 });
  const c = db.read('campaigns/' + cid);
  assert.strictEqual(c.status, 'finished');
  assert.strictEqual(c.delivered, 41600);
  assert.ok(c.finishedAt);
  assert.strictEqual(mails.length, 1);
  assert.match(mails[0].subject, /finished/);
  assert.match(mails[0].text, /41,600/);
  assert.match(mails[0].text, /ad-status\.html\?i=/);
  assert.strictEqual(Object.values(db.read('submissions/-Npush0000000000001/log')).at(-1).to, 'finished');
  assert.deepStrictEqual(await deliveryCheck(ctx), { checked: 0, finished: 0 }, 'and it is not counted again');
});

test('the owner\'s own campaigns are never touched', async () => {
  const db = new FakeDb({ campaigns: { '-Nmine': { status: 'active', kind: 'house', title: 'Mine' } }, stats: { '-Nmine': { 20261010: { tvdsp: { BG: { imp: 999999 } } } } } });
  const { ctx } = makeCtx(db, new FakeBucket());
  assert.deepStrictEqual(await deliveryCheck(ctx), { checked: 0, finished: 0 });
  assert.strictEqual(db.read('campaigns/-Nmine').status, 'active');
  assert.strictEqual(db.read('campaigns/-Nmine').delivered, undefined);
});
