'use strict';
// Campaigns that came from a paid request run until everything that was paid for has been shown, then
// they finish by themselves (ADS-PLAN.md, section 9). There is no end date to chase. A person can
// pause a campaign at any time.
//
// For now the impressions are counted from stats/{campaign}, all apps and formats together. Per format
// counting comes with the verified counters (phase F).

const { safeSend } = require('./submit');
const { linkOf } = require('./review');
const { finishedEmail } = require('./mail');

/** All impressions under stats/{campaign}/{day}/{app}/{country}/imp. */
function sumImpressions(stats) {
  let n = 0;
  for (const apps of Object.values(stats || {})) {
    for (const ccs of Object.values(apps || {})) {
      for (const v of Object.values(ccs || {})) n += Number(v && v.imp) || 0;
    }
  }
  return n;
}

/** Counts, and finishes what is done. Returns { checked, finished }. */
async function deliveryCheck(ctx) {
  const { db, now } = ctx;
  const all = (await db.ref('campaigns').get()).val() || {};
  let checked = 0, finished = 0;
  for (const [cid, c] of Object.entries(all)) {
    if (!c || c.source !== 'submission' || c.status !== 'active' || !(c.budget && c.budget.target > 0)) continue;
    checked++;
    const delivered = sumImpressions((await db.ref('stats/' + cid).get()).val());
    const done = delivered >= c.budget.target;
    if (!done && delivered === (c.delivered || 0)) continue;
    // Only write what changed: every write under campaigns/ rebuilds the feed.
    const upd = { delivered };
    if (done) Object.assign(upd, { status: 'finished', finishedAt: now, updatedAt: now });
    await db.ref('campaigns/' + cid).update(upd);
    if (!done) continue;
    finished++;
    const sid = c.submissionId;
    const rec = sid ? (await db.ref('submissions/' + sid).get()).val() : null;
    if (rec) {
      await db.ref('submissions/' + sid).update({ updatedAt: now, ['log/' + now]: { by: 'system', from: 'active', to: 'finished' } });
      await safeSend(ctx, { to: rec.advertiser.email, ...finishedEmail(rec, rec.ref, await linkOf(db, ctx, sid), delivered) }, 'advertiser');
    }
  }
  return { checked, finished };
}

module.exports = { deliveryCheck, sumImpressions };
