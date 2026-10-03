'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sniff, checkFile, validateInput } = require('../lib/spec');
const { processSubmission, processResubmission, InvalidRequest, RateLimited, NotAllowed } = require('../lib/submit');

// ── helpers ─────────────────────────────────────────────────────────────────
const { FakeDb, FakeBucket, png, gif, mp4, makeCtx } = require('./fakes');
const NOW = Date.parse('2026-10-10T12:00:00Z');
const goodPath = 'uploads/AbCdEfGhIjKlMnOpQr/banner.png';
const SID = '-Npush0000000000001';

const input = (over = {}) => ({
  advertiser: { name: 'Ann', company: 'Acme', email: 'ann@acme.com', country: 'bg', vat: '' },
  ad: { title: 'Acme app', description: 'Try it', clickUrl: 'https://acme.com/x' },
  apps: { tvdsp: { banner: { path: goodPath } } },
  countries: [],
  startDate: '2026-10-14',
  budget: { target: 100000 },
  terms: true,
  ...over,
});

function fakes(files) {
  const db = new FakeDb(), bucket = new FakeBucket(files);
  const { ctx, mails } = makeCtx(db, bucket);
  return { ctx, db, bucket, mails, moved: () => bucket.log.filter(x => x[0] === 'move').map(x => x.slice(1)) };
}

// ── file recognition ────────────────────────────────────────────────────────
test('sniff recognises png, gif and mp4 by content', () => {
  assert.deepStrictEqual(sniff(png(640, 100)), { kind: 'image', ext: 'png', mime: 'image/png', w: 640, h: 100 });
  assert.strictEqual(sniff(gif(600, 500)).kind, 'gif');
  assert.strictEqual(sniff(mp4()).kind, 'video');
  assert.strictEqual(sniff(Buffer.from('<html>not an image</html>')), null);
});

test('checkFile: size of the picture, kind per slot, weight', () => {
  assert.strictEqual(checkFile('banner', sniff(png(640, 100)), 5000), null);
  assert.match(checkFile('banner', sniff(png(300, 100)), 5000), /exactly 640×100/);
  assert.match(checkFile('banner', sniff(mp4()), 5000), /accepts an image or a GIF/);
  assert.strictEqual(checkFile('fullscreen', sniff(mp4()), 5 * 1024 * 1024), null);
  assert.match(checkFile('fullscreen', sniff(mp4()), 7 * 1024 * 1024), /too large/);
  assert.match(checkFile('banner', sniff(png(640, 100)), 2 * 1024 * 1024), /too large/);
  assert.strictEqual(checkFile('mrec', sniff(gif(600, 500)), 1.5 * 1024 * 1024), null);
  assert.match(checkFile('banner', null, 10), /not a supported/);
});

// ── fields ──────────────────────────────────────────────────────────────────
test('validateInput accepts a good request and normalises it', () => {
  const { errors, value } = validateInput(input(), NOW);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(value.advertiser.country, 'BG');
  assert.strictEqual(value.from, Date.parse('2026-10-14T00:00:00Z'));
  assert.deepStrictEqual(value.files, [{ app: 'tvdsp', slot: 'banner', path: goodPath }]);
});

test('validateInput reports each problem on its field', () => {
  const bad = input({
    advertiser: { name: '', email: 'nope', country: 'Bulgaria' },
    ad: { title: 'x'.repeat(61), clickUrl: 'http://acme.com' },
    apps: { tvdsp: { mrec: { path: goodPath } }, nope: {} },
    countries: ['BG', 'xx1'],
    startDate: '2026-10-11',
    budget: { target: 5 },
    terms: false,
  });
  const fields = validateInput(bad, NOW).errors.map(e => e.field);
  for (const f of ['name', 'email', 'country', 'title', 'clickUrl', 'apps', 'countries', 'startDate', 'target', 'terms']) {
    assert.ok(fields.includes(f), f + ' should be reported, got ' + fields);
  }
});

test('new lines cannot get into one-line fields; the description keeps its lines', () => {
  const { value } = validateInput(input({
    advertiser: { name: 'Ann\r\nBcc: x@y.z', email: 'ann@acme.com', country: 'BG' },
    ad: { title: 'Line1\nLine2', description: 'a\nb', clickUrl: 'https://acme.com/x' },
  }), NOW);
  assert.strictEqual(value.advertiser.name, 'Ann  Bcc: x@y.z');
  assert.strictEqual(value.ad.title, 'Line1 Line2');
  assert.strictEqual(value.ad.description, 'a\nb');
});

test('an app without files, and no app at all, are errors', () => {
  assert.ok(validateInput(input({ apps: { tvdsp: {} } }), NOW).errors.some(e => e.field === 'app:tvdsp'));
  assert.ok(validateInput(input({ apps: {} }), NOW).errors.some(e => e.field === 'apps'));
});

test('upload paths cannot point anywhere else in the bucket', () => {
  const e = validateInput(input({ apps: { tvdsp: { banner: { path: 'campaigns/x/a.png' } } } }), NOW).errors;
  assert.ok(e.some(x => x.field === 'file:tvdsp/banner'));
});

test('start date: at least 3 days ahead, at most a year', () => {
  assert.ok(!validateInput(input({ startDate: '2026-10-13' }), NOW).errors.some(e => e.field === 'startDate'));
  assert.ok(validateInput(input({ startDate: '2026-10-12' }), NOW).errors.some(e => e.field === 'startDate'));
  assert.ok(validateInput(input({ startDate: '2028-01-01' }), NOW).errors.some(e => e.field === 'startDate'));
  assert.ok(validateInput(input({ startDate: 'tomorrow' }), NOW).errors.some(e => e.field === 'startDate'));
});

// ── the whole flow ──────────────────────────────────────────────────────────
test('a good request is saved, files are moved, both sides get an email', async () => {
  const { ctx, db, moved, mails } = fakes({ [goodPath]: png(640, 100, 2000) });
  const r = await processSubmission(input(), ctx);
  assert.strictEqual(r.ok, true);
  assert.match(r.ref, /^[0-9A-F]{8}$/);
  const rec = db.read('submissions/' + SID);
  assert.strictEqual(rec.status, 'pending');
  assert.strictEqual(rec.advertiser.email, 'ann@acme.com');
  assert.strictEqual(rec.budget.target, 100000);
  assert.deepStrictEqual(rec.slots.tvdsp.banner.file, 'submissions/' + SID + '/tvdsp_banner.png');
  assert.strictEqual(rec.slots.tvdsp.banner.w, 640);
  assert.strictEqual(JSON.stringify(rec).includes('TOKEN1234567890abcdef'), false, 'the token is not in the request itself');
  assert.strictEqual(db.read('tokens/' + SID), 'TOKEN1234567890abcdef', 'it is in tokens/, which only the functions read');
  assert.deepStrictEqual(moved(), [[goodPath, 'submissions/' + SID + '/tvdsp_banner.png']]);
  assert.strictEqual(mails.length, 2);
  assert.strictEqual(mails[0].to, 'ann@acme.com');
  assert.match(mails[0].text, /ad-status\.html\?i=-Npush0000000000001&t=TOKEN1234567890abcdef/);
  assert.strictEqual(mails[1].to, 'admin@x.dev');
  assert.strictEqual(mails[1].replyTo, 'ann@acme.com');
});

test('a wrong file is reported on its slot and nothing is saved', async () => {
  const { ctx, db, moved, mails } = fakes({ [goodPath]: png(300, 100) });
  await assert.rejects(() => processSubmission(input(), ctx), e => e instanceof InvalidRequest && e.errors[0].field === 'file:tvdsp/banner');
  assert.strictEqual(db.read('submissions'), undefined);
  assert.strictEqual(moved().length, 0);
  assert.strictEqual(mails.length, 0);
});

test('an upload that is not there is an error', async () => {
  const { ctx } = fakes({});
  await assert.rejects(() => processSubmission(input(), ctx), e => e instanceof InvalidRequest && /missing/.test(e.errors[0].msg));
});

test('a big video is only read at the start, and a non-image renamed .png is refused', async () => {
  const big = mp4(5 * 1024 * 1024);
  const p = 'uploads/AbCdEfGhIjKlMnOpQr/v.mp4';
  const { ctx } = fakes({ [p]: big });
  const r = await processSubmission(input({ apps: { worldradio: { fullscreen: { path: p } } } }), ctx);
  assert.strictEqual(r.ok, true);
  const f2 = fakes({ [goodPath]: Buffer.from('<script>alert(1)</script>'.padEnd(40)) });
  await assert.rejects(() => processSubmission(input(), f2.ctx), InvalidRequest);
});

test('the hidden field catches bots: success, but nothing stored or sent', async () => {
  const { ctx, db, mails } = fakes({ [goodPath]: png(640, 100) });
  const r = await processSubmission(input({ website: 'http://spam' }), ctx);
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(db.root, {});
  assert.strictEqual(mails.length, 0);
});

test('the sixth request from one address in an hour is refused', async () => {
  const { ctx } = fakes({});
  for (let i = 0; i < 5; i++) await assert.rejects(() => processSubmission(input(), ctx), InvalidRequest);
  await assert.rejects(() => processSubmission(input(), ctx), RateLimited);
});

test('a failing email does not lose the saved request', async () => {
  const { ctx, db } = fakes({ [goodPath]: png(640, 100) });
  ctx.sendMail = async () => { throw new Error('Resend down'); };
  const r = await processSubmission(input(), ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(db.read('submissions/' + SID));
});
