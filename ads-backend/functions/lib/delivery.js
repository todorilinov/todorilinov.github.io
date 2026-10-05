'use strict';
// Campaigns that came from a paid request run until everything that was paid for has been shown, then
// they finish by themselves (ADS-PLAN.md, section 9). There is no end date to chase. A person can
// pause a campaign at any time.
//
// Each format is paid for separately (budget.items.{app}.{slot}.impressions) and stops separately: when its
// impressions are all shown it is marked done, and the feed no longer offers it. When every format is done
// the campaign is finished. Impressions are counted from vstats/{campaign}/{day}/{app}/{slot}/{country},
// which only the `track` function writes (App Check).

const { safeSend } = require('./submit');
const { linkOf } = require('./review');
const { finishedEmail } = require('./mail');

/** vstats/{campaign}/{day}/{app}/{slot}/{country}/{imp|clk} -> impressions and clicks per format, and in total. */
function sumByFormat(vstats) {
  const by = {};
  let imp = 0, clk = 0;
  for (const apps of Object.values(vstats || {})) {
    for (const [app, slots] of Object.entries(apps || {})) {
      for (const [slot, ccs] of Object.entries(slots || {})) {
        for (const v of Object.values(ccs || {})) {
          const i = Number(v && v.imp) || 0, c = Number(v && v.clk) || 0;
          const f = (by[app] = by[app] || {})[slot] = (by[app] || {})[slot] || { imp: 0, clk: 0 };
          f.imp += i; f.clk += c; imp += i; clk += c;
        }
      }
    }
  }
  return { by, imp, clk };
}

const same = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});

/** Counts, stops the formats that are done and finishes the campaigns that are done. Returns { checked, finished, slotsDone }. */
async function deliveryCheck(ctx) {
  const { db, now } = ctx;
  const all = (await db.ref('campaigns').get()).val() || {};
  let checked = 0, finished = 0, slotsDone = 0;
  for (const [cid, c] of Object.entries(all)) {
    if (!c || c.source !== 'submission' || c.status !== 'active' || !(c.budget && c.budget.target > 0)) continue;
    checked++;
    const s = sumByFormat((await db.ref('vstats/' + cid).get()).val());

    // Per format. A request from before the formats were paid for separately has only a total.
    const done = JSON.parse(JSON.stringify(c.done || {}));
    const items = c.budget.items || {};
    let all_done = Object.keys(items).length > 0, newly = 0;
    for (const [app, slots] of Object.entries(items)) {
      for (const [slot, it] of Object.entries(slots || {})) {
        const got = (s.by[app] && s.by[app][slot] && s.by[app][slot].imp) || 0;
        const isDone = (done[app] && done[app][slot]) || got >= it.impressions;
        if (isDone && !(done[app] && done[app][slot])) { (done[app] = done[app] || {})[slot] = true; newly++; }
        if (!isDone) all_done = false;
      }
    }
    if (!Object.keys(items).length) all_done = s.imp >= c.budget.target;
    slotsDone += newly;

    const deliveredBy = {};
    for (const [app, slots] of Object.entries(s.by)) for (const [slot, f] of Object.entries(slots)) (deliveredBy[app] = deliveredBy[app] || {})[slot] = f.imp;
    const upd = {};
    if (s.imp !== (c.delivered || 0)) upd.delivered = s.imp;
    if (!same(deliveredBy, c.deliveredBy)) upd.deliveredBy = deliveredBy;
    if (newly) upd.done = done;
    if (all_done) Object.assign(upd, { status: 'finished', finishedAt: now, updatedAt: now });
    // Only write what changed: every write under campaigns/ rebuilds the feed.
    if (!Object.keys(upd).length) continue;
    await db.ref('campaigns/' + cid).update(upd);
    if (!all_done) continue;

    finished++;
    const sid = c.submissionId;
    const rec = sid ? (await db.ref('submissions/' + sid).get()).val() : null;
    if (rec) {
      await db.ref('submissions/' + sid).update({ updatedAt: now, ['log/' + now]: { by: 'system', from: 'active', to: 'finished' } });
      await safeSend(ctx, { to: rec.advertiser.email, ...finishedEmail(rec, rec.ref, await linkOf(db, ctx, sid), s.imp) }, 'advertiser');
    }
  }
  return { checked, finished, slotsDone };
}

module.exports = { deliveryCheck, sumByFormat };
