'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildFeed, sameFeed, normalize } = require('../lib/feed');

const creative = { type: 'image', url: 'https://x/b.webp', w: 640, h: 100, extra: 'dropped' };
const base = {
  status: 'active', title: 'T', clickUrl: 'https://tiapps.dev',
  apps: { worldradio: true, tvdsp: true },
  slots: { worldradio: { banner: creative, mrec: { type: 'image', url: '' } }, tvdsp: { banner: creative } },
};

test('only active campaigns of the app, only slots with a file', () => {
  const f = buildFeed({ a: base, b: { ...base, status: 'paused' }, c: { ...base, apps: { tvdsp: true } } }, 'worldradio', 1);
  assert.deepStrictEqual(Object.keys(f.campaigns), ['a']);
  assert.deepStrictEqual(Object.keys(f.campaigns.a.slots), ['banner']);
  assert.deepStrictEqual(f.campaigns.a.slots.banner, { type: 'image', url: 'https://x/b.webp', w: 640, h: 100 });
});

test('defaults like the browser version', () => {
  const c = buildFeed({ a: base }, 'tvdsp', 1).campaigns.a;
  assert.strictEqual(c.kind, 'house');
  assert.strictEqual(c.weight, 10);
  assert.deepStrictEqual(c.cap, { n: 3, per: 'hour' });
  assert.strictEqual(c.from, undefined);   // null is not stored by the database
  assert.strictEqual(c.countries, undefined);
});

test('no ads for the app → empty feed without campaigns', () => {
  const f = buildFeed({ a: base }, 'fakelocation', 5);
  assert.deepStrictEqual(f, { v: 1, updatedAt: 5 });
});

test('sameFeed ignores updatedAt and database-dropped values', () => {
  const a = buildFeed({ a: base }, 'worldradio', 1);
  const stored = JSON.parse(JSON.stringify(a));
  stored.updatedAt = 999;
  assert.ok(sameFeed(stored, buildFeed({ a: base }, 'worldradio', 2)));
  assert.ok(!sameFeed(stored, buildFeed({ a: { ...base, title: 'Other' } }, 'worldradio', 2)));
  assert.ok(!sameFeed(stored, buildFeed({}, 'worldradio', 2)));
});

test('normalize removes nulls and empties', () => {
  assert.deepStrictEqual(normalize({ a: null, b: [], c: { d: null }, e: 0, f: '' }), { e: 0, f: '' });
});
