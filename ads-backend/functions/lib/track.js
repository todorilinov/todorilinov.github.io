'use strict';
// What the apps send about their ads: impressions, clicks and "the slot asked for an ad" (ADS-PLAN.md, section 11).
// Paid campaigns are billed only from what is counted here (vstats/), never from the old stats/ that anyone could write.
//
//   POST /track   (header X-Firebase-AppCheck: the App Check token of the app)
//   { "v":1, "app":"worldradio", "bid":"<random 16-40 chars, new for every batch>",
//     "events":[ { "c":"<campaign id>", "s":"banner", "cc":"BG", "imp":3, "clk":1 }, ... ],
//     "opp":[ { "s":"banner", "cc":"BG", "n":12 }, ... ] }
//
// Written: vstats/{campaign}/{day}/{app}/{slot}/{country}/{imp|clk}   and   inventory/{day}/{app}/{slot}/{country}
// The day is the server's (UTC): a phone cannot move numbers to another day.
// Dropped quietly: unknown campaigns, slots the campaign has no file for. Refused: bad shape, no valid token (when
// it is required), too many from one address. A repeated batch id is acknowledged and not counted again.

const { APPS } = require('./spec');
const { hit, ipHashOf, DAY_MS } = require('./submit');

const HOUR = 3600000;
const CID = /^-[\w-]{19}$/;
const BID = /^[\w-]{16,40}$/;
const CC = /^[A-Z]{2}$/;
const MAX_EVENTS = 60, MAX_OPP_ROWS = 30;
const MAX_N = 100;          // impressions or clicks of one event
const MAX_OPP = 5000;       // ad requests of one row
const LIMITS = { requests: 60, imp: 600, clk: 60, opp: 5000 };   // per address and hour

/** A refusal; [status] is the HTTP status the app gets. */
class TrackError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const int = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

/** Checks the shape of a batch. Returns the clean batch or throws TrackError(400). */
function parse(body) {
  const bad = why => { throw new TrackError(400, why); };
  if (!body || typeof body !== 'object' || body.v !== 1) bad('Unknown version.');
  const app = body.app;
  if (!APPS[app]) bad('Unknown app.');
  if (typeof body.bid !== 'string' || !BID.test(body.bid)) bad('Bad batch id.');
  const events = body.events == null ? [] : body.events;
  const opp = body.opp == null ? [] : body.opp;
  if (!Array.isArray(events) || events.length > MAX_EVENTS) bad('Too many events.');
  if (!Array.isArray(opp) || opp.length > MAX_OPP_ROWS) bad('Too many rows.');
  const slots = APPS[app].slots;
  const ev = events.map(e => {
    if (!e || typeof e.c !== 'string' || !CID.test(e.c) || !slots.includes(e.s) || !CC.test(e.cc)) bad('Bad event.');
    const imp = e.imp == null ? 0 : e.imp, clk = e.clk == null ? 0 : e.clk;
    if (!int(imp, MAX_N) || !int(clk, MAX_N)) bad('Bad count.');
    return { c: e.c, s: e.s, cc: e.cc, imp, clk };
  });
  const op = opp.map(o => {
    if (!o || !slots.includes(o.s) || !CC.test(o.cc) || !int(o.n, MAX_OPP)) bad('Bad row.');
    return { s: o.s, cc: o.cc, n: o.n };
  });
  return { app, bid: body.bid, events: ev, opp: op };
}

/**
 * @param {object} body
 * @param {string|undefined} token   X-Firebase-AppCheck
 * @param {object} ctx  { now, ip, db, increment(n), campaigns(): {id: {slots:{app:{slot:true}}}}, verifyAppCheck(token, app), requireAppCheck }
 * @returns {Promise<{ok:true, imp:number, clk:number, opp:number, duplicate?:true}>}
 */
async function ingest(body, token, ctx) {
  const { db, now } = ctx;
  const b = parse(body);

  const ip = ipHashOf(ctx.ip);
  if (!(await hit(db, 'track/req/' + ip, LIMITS.requests, HOUR, now))) throw new TrackError(429, 'Too many requests.');

  // The token says "this is the real app". When it is not required yet (while the apps are being updated) a
  // missing or wrong token is let through, so the whole chain can be tried before it is switched on.
  const valid = token ? await ctx.verifyAppCheck(token, b.app) : false;
  if (ctx.requireAppCheck && !valid) throw new TrackError(403, 'App Check failed.');

  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  const seenPath = 'trackseen/' + Math.floor(now / DAY_MS) + '/' + b.bid;
  if ((await db.ref(seenPath).get()).val()) return { ok: true, imp: 0, clk: 0, opp: 0, duplicate: true };

  const known = await ctx.campaigns();
  const up = {};
  let imp = 0, clk = 0, opp = 0;
  const add = (path, n) => { if (n > 0) up[path] = (up[path] || 0) + n; };
  for (const e of b.events) {
    const c = known[e.c];
    if (!c || !(c.slots && c.slots[b.app] && c.slots[b.app][e.s])) continue;   // not a campaign of this app and format
    const base = 'vstats/' + e.c + '/' + day + '/' + b.app + '/' + e.s + '/' + e.cc + '/';
    add(base + 'imp', e.imp); add(base + 'clk', e.clk);
    imp += e.imp; clk += e.clk;
  }
  for (const o of b.opp) { add('inventory/' + day + '/' + b.app + '/' + o.s + '/' + o.cc, o.n); opp += o.n; }

  // What one address can send in an hour is limited, so a script cannot pour numbers in.
  if (imp && !(await hit(db, 'track/imp/' + ip, LIMITS.imp, HOUR, now, imp))) throw new TrackError(429, 'Too many impressions.');
  if (clk && !(await hit(db, 'track/clk/' + ip, LIMITS.clk, HOUR, now, clk))) throw new TrackError(429, 'Too many clicks.');
  if (opp && !(await hit(db, 'track/opp/' + ip, LIMITS.opp, HOUR, now, opp))) throw new TrackError(429, 'Too many requests for ads.');

  if (Object.keys(up).length) {
    const inc = {};
    for (const [p, n] of Object.entries(up)) inc[p] = ctx.increment(n);
    await db.ref('/').update(inc);
  }
  await db.ref(seenPath).set(now);
  return { ok: true, imp, clk, opp };
}

module.exports = { ingest, parse, TrackError, LIMITS };
