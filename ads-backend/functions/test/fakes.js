'use strict';
// A small in-memory Realtime Database and Storage bucket, enough for the logic in lib/.

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class FakeDb {
  constructor(initial) { this.root = initial ? clone(initial) : {}; this.pushes = 0; }
  _walk(path, create) {
    const keys = path.split('/').filter(Boolean);
    let o = this.root;
    for (const k of keys.slice(0, -1)) {
      if (o[k] == null || typeof o[k] !== 'object') { if (!create) return [null, null]; o[k] = {}; }
      o = o[k];
    }
    return [o, keys[keys.length - 1]];
  }
  read(path) { const [o, k] = this._walk(path, false); return o ? clone(o[k]) : undefined; }
  write(path, v) {
    const [o, k] = this._walk(path, true);
    // ServerValue.increment(n) is { ".sv": { "increment": n } }
    if (v && typeof v === 'object' && v['.sv'] && typeof v['.sv'].increment === 'number') { o[k] = (Number(o[k]) || 0) + v['.sv'].increment; return; }
    if (v === null || v === undefined) delete o[k]; else o[k] = clone(v);
  }
  ref(path) {
    const db = this;
    return {
      push() { db.pushes++; return { key: '-Npush' + String(db.pushes).padStart(13, '0') }; },
      async get() { const v = db.read(path); return { val: () => (v === undefined ? null : v) }; },
      async set(v) { db.write(path, v); },
      async update(obj) { for (const [k, v] of Object.entries(obj)) db.write((path === '/' ? '' : path) + '/' + k, v); },
      async remove() { db.write(path, null); },
      async transaction(fn) { const v = fn(db.read(path)); db.write(path, v); return { snapshot: { val: () => v } }; },
    };
  }
}

class FakeBucket {
  constructor(files) { this.name = 'test-bucket'; this.files = new Map(Object.entries(files || {})); this.log = []; }
  file(path) {
    const b = this;
    return {
      async exists() { return [b.files.has(path)]; },
      async getMetadata() { return [{ size: String(b.files.get(path).length) }]; },
      async download(o) { const buf = b.files.get(path); return [o && o.end != null ? buf.slice(o.start, o.end + 1) : buf]; },
      async move(dest) { b.files.set(dest, b.files.get(path)); b.files.delete(path); b.log.push(['move', path, dest]); },
      async copy(dest) { b.files.set(dest, b.files.get(path)); b.log.push(['copy', path, dest]); },
      async delete() { b.files.delete(path); b.log.push(['delete', path]); },
    };
  }
}

// ── file builders ───────────────────────────────────────────────────────────
const png = (w, h, pad = 0) => {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 2;
  return b;
};
const gif = (w, h) => { const b = Buffer.alloc(20); b.write('GIF89a'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
const mp4 = (size = 100) => { const b = Buffer.alloc(size); b.writeUInt32BE(24, 0); b.write('ftypisom', 4); return b; };

let sessions = 0;
function makeCtx(db, bucket, over = {}) {
  const mails = [];
  const ctx = {
    now: Date.parse('2026-10-10T12:00:00Z'), ip: '1.2.3.4', db, bucket, bucketName: bucket.name,
    adminEmail: 'admin@x.dev', baseUrl: 'https://tiapps.dev', newToken: () => 'TOKEN1234567890abcdef',
    newCode: () => '123456', newSession: () => 'SESSION-' + (++sessions) + '-abcdefghijklmnop',
    sendMail: async m => { mails.push(m); }, log: () => {}, ...over,
  };
  return { ctx, mails };
}

module.exports = { FakeDb, FakeBucket, png, gif, mp4, makeCtx };
