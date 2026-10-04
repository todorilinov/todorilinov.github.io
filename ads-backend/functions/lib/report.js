'use strict';
// The report of a campaign, for the advertiser (ADS-PLAN.md, section 10).
//
// The link (id + secret token) alone shows nothing. The advertiser asks for a code, it goes to the email
// address of the request, and only the right code opens a session of 30 minutes. So a forwarded link
// does not give the report away.
//
//  code:    6 digits, valid 10 minutes, single use, 5 wrong tries lock it for 15 minutes
//  asking:  at least 60 seconds apart, at most 5 times an hour for a request; the answer is the same
//           whether the address matched or not, so nobody can find out which address is registered
//  session: random, only its hash is kept; at most 5 at a time

const crypto = require('crypto');
const { APPS } = require('./spec');
const { tokenOk, hit, ipHashOf, safeSend, sha256, RateLimited, NotAllowed } = require('./submit');
const { effectiveStatus } = require('./review');
const { codeEmail } = require('./mail');

const MIN = 60000;
const HOUR = 3600000;
const CODE_VALID = 10 * MIN;
const SESSION_VALID = 30 * MIN;
const LOCK_FOR = 15 * MIN;
const RESEND_AFTER = MIN;
const MAX_TRIES = 5;
const MAX_ASKS_PER_HOUR = 5;
const MAX_SESSIONS = 5;

/** A wrong or expired code, or a wrong session. The text is the same for every reason. */
class BadCode extends Error {
  constructor(msg) { super(msg || 'That code is not correct or has expired.'); }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const sessionKey = s => sha256('session|' + s).slice(0, 32);
const codeHash = (salt, code) => sha256(salt + '|' + code);

async function load(db, id) {
  return (await db.ref('submissions/' + id).get()).val();
}

/** "Send me a code." Always answers { ok: true } unless asked too often. */
async function requestCode(d, ctx) {
  const { db, now } = ctx;
  d = d && typeof d === 'object' ? d : {};
  if (!(await hit(db, 'otp/ip/' + ipHashOf(ctx.ip), 10, HOUR, now))) throw new RateLimited();
  if (!(await tokenOk(db, d.id, d.token))) throw new NotAllowed('This link is not valid.');
  const rec = await load(db, d.id);
  if (!rec) throw new NotAllowed('This link is not valid.');

  const state = (await db.ref('otp/' + d.id).get()).val() || {};
  if (state.lockedUntil > now) throw new RateLimited('Too many wrong codes. Please try again in a few minutes.');
  // These limits count every call, whether the address matches or not: otherwise they would give it away.
  if (state.sentAt && now - state.sentAt < RESEND_AFTER) throw new RateLimited('Please wait a minute before asking for a new code.');
  if (!(await hit(db, 'otpsend/' + d.id, MAX_ASKS_PER_HOUR, HOUR, now))) throw new RateLimited('You asked for too many codes. Please try again in an hour.');
  await db.ref('otp/' + d.id + '/sentAt').set(now);

  const email = typeof d.email === 'string' ? d.email.trim().toLowerCase() : '';
  if (!email || email !== String(rec.advertiser.email).trim().toLowerCase()) return { ok: true };

  const code = ctx.newCode();
  const salt = ctx.newSession();
  await db.ref('otp/' + d.id).update({ hash: codeHash(salt, code), salt, expires: now + CODE_VALID, attempts: 0 });
  await safeSend(ctx, { to: rec.advertiser.email, ...codeEmail(rec, rec.ref, code) }, 'advertiser');
  return { ok: true };
}

/** "Here is the code." Returns a session. */
async function verifyCode(d, ctx) {
  const { db, now } = ctx;
  d = d && typeof d === 'object' ? d : {};
  if (!(await hit(db, 'otpverify/ip/' + ipHashOf(ctx.ip), 30, HOUR, now))) throw new RateLimited();
  if (!(await tokenOk(db, d.id, d.token))) throw new NotAllowed('This link is not valid.');

  const st = (await db.ref('otp/' + d.id).get()).val() || {};
  if (st.lockedUntil > now) throw new RateLimited('Too many wrong codes. Please try again in a few minutes.');
  const code = typeof d.code === 'string' ? d.code.replace(/\s/g, '') : '';
  if (!st.hash || !(st.expires > now) || !/^\d{6}$/.test(code)) throw new BadCode();

  if (!safeEqual(codeHash(st.salt, code), st.hash)) {
    const attempts = (st.attempts || 0) + 1;
    // After the last try the code is gone: a new one has to be asked for.
    await db.ref('otp/' + d.id).update(attempts >= MAX_TRIES
      ? { hash: null, salt: null, expires: null, attempts: 0, lockedUntil: now + LOCK_FOR }
      : { attempts });
    throw new BadCode();
  }

  // Right code: it works once.
  const session = ctx.newSession();
  const sessions = {};
  for (const [k, exp] of Object.entries(st.sessions || {})) if (exp > now) sessions[k] = exp;
  const keep = Object.entries(sessions).sort((a, b) => b[1] - a[1]).slice(0, MAX_SESSIONS - 1);
  const next = Object.fromEntries(keep);
  next[sessionKey(session)] = now + SESSION_VALID;
  await db.ref('otp/' + d.id).update({ hash: null, salt: null, expires: null, attempts: 0, sessions: next });
  return { session, expiresAt: now + SESSION_VALID };
}

const num = v => Number(v) || 0;

/** stats/{campaign}/{day}/{app}/{country} -> totals by day, country and app. */
function summarize(stats) {
  const byDay = {}, byCc = {}, byApp = {};
  let imp = 0, clk = 0;
  const add = (m, k, i, c) => { const r = m[k] || (m[k] = { imp: 0, clk: 0 }); r.imp += i; r.clk += c; };
  for (const [day, apps] of Object.entries(stats || {})) {
    for (const [app, ccs] of Object.entries(apps || {})) {
      for (const [cc, v] of Object.entries(ccs || {})) {
        const i = num(v && v.imp), c = num(v && v.clk);
        imp += i; clk += c;
        add(byDay, day, i, c); add(byCc, cc, i, c); add(byApp, app, i, c);
      }
    }
  }
  const list = (m, key) => Object.entries(m).map(([k, v]) => ({ [key]: k, ...v }));
  return {
    totals: { imp, clk },
    byDay: list(byDay, 'day').sort((a, b) => a.day.localeCompare(b.day)),
    byCountry: list(byCc, 'cc').sort((a, b) => b.imp - a.imp || a.cc.localeCompare(b.cc)),
    byApp: list(byApp, 'app').sort((a, b) => b.imp - a.imp).map(r => ({ ...r, name: APPS[r.app] ? APPS[r.app].name : r.app })),
  };
}

/** The report, for a session that was opened with a code. */
async function reportData(d, ctx) {
  const { db, now } = ctx;
  d = d && typeof d === 'object' ? d : {};
  if (!(await hit(db, 'otpdata/ip/' + ipHashOf(ctx.ip), 120, HOUR, now))) throw new RateLimited();
  if (!(await tokenOk(db, d.id, d.token))) throw new NotAllowed('This link is not valid.');
  const st = (await db.ref('otp/' + d.id).get()).val() || {};
  const exp = typeof d.session === 'string' && st.sessions ? st.sessions[sessionKey(d.session)] : 0;
  if (!(exp > now)) throw new NotAllowed('Your session has ended. Please ask for a new code.', 'unauthenticated');

  const rec = await load(db, d.id);
  if (!rec) throw new NotAllowed('This link is not valid.');
  const campaign = rec.campaignId ? (await db.ref('campaigns/' + rec.campaignId).get()).val() : null;
  const out = {
    ref: rec.ref, title: rec.title, status: effectiveStatus(rec, campaign), from: rec.from,
    budget: { target: rec.budget && rec.budget.target, amount: rec.budget && rec.budget.amount, currency: (rec.budget && rec.budget.currency) || 'EUR' },
    hasCampaign: !!campaign, expiresAt: exp,
  };
  if (!campaign) return out;
  const stats = (await db.ref('stats/' + rec.campaignId).get()).val();
  const s = summarize(stats);
  return { ...out, delivered: s.totals.imp, ...s, updatedAt: now };
}

module.exports = { requestCode, verifyCode, reportData, summarize, BadCode, CODE_VALID, SESSION_VALID };
