'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sniff, checkFile, validateInput } = require('../lib/spec');
const { processSubmission, InvalidRequest, RateLimited } = require('../lib/submit');

// ── helpers ─────────────────────────────────────────────────────────────────
const png = (w, h, pad = 0) => {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 2;
  return b;
};
const gif = (w, h) => {
  const b = Buffer.alloc(20); b.write('GIF89a'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b;
};
const mp4 = (size = 100) => { const b = Buffer.alloc(size); b.writeUInt32BE(24, 0); b.write('ftypisom', 4); return b; };

const NOW = Date.parse('2026-10-10T12:00:00Z');
const goodPath = 'uploads/AbCdEfGhIjKlMnOpQr/banner.png';

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
  const store = new Map(Object.entries(files));
  const db = {
    data: {},
    ref(path) {
      const self = this;
      return {
        push() { return { key: '-Nabc123def456ghi789' }; },
        async set(v) { self.data[path] = JSON.parse(JSON.stringify(v)); },
        async transaction(fn) { const v = fn(self.data[path]); self.data[path] = v; return { snapshot: { val: () => v } }; },
      };
    },
  };
  const moved = [];
  const bucket = {
    file(path) {
      return {
        async exists() { return [store.has(path)]; },
        async getMetadata() { return [{ size: String(store.get(path).length) }]; },
        async download(o) { const b = store.get(path); return [o && o.end != null ? b.slice(o.start, o.end + 1) : b]; },
        async move(dest) { moved.push([path, dest]); },
      };
    },
  };
  const mails = [];
  const ctx = {
    now: NOW, ip: '1.2.3.4', db, bucket, adminEmail: 'admin@x.dev', baseUrl: 'https://tiapps.dev',
    newToken: () => 'TOKEN123', sendMail: async m => { mails.push(m); }, log: () => {},
  };
  return { ctx, db, moved, mails };
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
  const rec = db.data['submissions/-Nabc123def456ghi789'];
  assert.strictEqual(rec.status, 'pending');
  assert.strictEqual(rec.advertiser.email, 'ann@acme.com');
  assert.strictEqual(rec.budget.target, 100000);
  assert.deepStrictEqual(rec.slots.tvdsp.banner.file, 'submissions/-Nabc123def456ghi789/tvdsp_banner.png');
  assert.strictEqual(rec.slots.tvdsp.banner.w, 640);
  assert.ok(rec.tokenHash && rec.tokenHash !== 'TOKEN123', 'only the hash of the token is stored');
  assert.strictEqual(JSON.stringify(rec).includes('TOKEN123'), false);
  assert.deepStrictEqual(moved, [[goodPath, 'submissions/-Nabc123def456ghi789/tvdsp_banner.png']]);
  assert.strictEqual(mails.length, 2);
  assert.strictEqual(mails[0].to, 'ann@acme.com');
  assert.match(mails[0].text, /ad-status\.html\?t=TOKEN123/);
  assert.strictEqual(mails[1].to, 'admin@x.dev');
  assert.strictEqual(mails[1].replyTo, 'ann@acme.com');
});

test('a wrong file is reported on its slot and nothing is saved', async () => {
  const { ctx, db, moved, mails } = fakes({ [goodPath]: png(300, 100) });
  await assert.rejects(() => processSubmission(input(), ctx), e => e instanceof InvalidRequest && e.errors[0].field === 'file:tvdsp/banner');
  assert.deepStrictEqual(Object.keys(db.data).filter(k => k.startsWith('submissions')), []);
  assert.strictEqual(moved.length, 0);
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
  assert.deepStrictEqual(db.data, {});
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
  assert.ok(db.data['submissions/-Nabc123def456ghi789']);
});
