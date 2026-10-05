'use strict';
// What the apps download (feed/{app}), built from campaigns/*.
// Pure functions, no Firebase: tested in test/feed.test.js.
// This is the same logic admin-ads.html used to run in the browser.

const APP_KEYS = ['worldradio', 'tvdsp', 'fakelocation'];

/** Drops null/undefined and empty arrays/objects: the Realtime Database does not store them. */
function normalize(v) {
  if (Array.isArray(v)) {
    const a = v.map(normalize).filter(x => x !== undefined);
    return a.length ? a : undefined;
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      const n = normalize(v[k]);
      if (n !== undefined) o[k] = n;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return v === null ? undefined : v;
}

/**
 * [version] 1 is the feed the apps released before the verified counters read (feed/{app}): the owner's own
 * ads only. A paid ad would be counted by the old, unverified counters, so it is never shown there.
 * Version 2 (feed2/{app}) has everything; the newer apps read it and count with `track`.
 * A format whose paid impressions are all shown (campaign.done.{app}.{slot}) leaves the feed.
 */
function buildFeed(campaigns, appKey, now, version = 1) {
  const out = {};
  for (const [id, c] of Object.entries(campaigns || {})) {
    if (!c || c.status !== 'active' || !c.apps || !c.apps[appKey]) continue;
    if (version === 1 && c.source === 'submission') continue;
    const src = (c.slots && c.slots[appKey]) || {};
    const done = (c.done && c.done[appKey]) || {};
    const slots = {};
    for (const [s, cr] of Object.entries(src)) {
      if (cr && cr.url && !done[s]) slots[s] = { type: cr.type, url: cr.url, w: cr.w, h: cr.h };
    }
    if (!Object.keys(slots).length) continue;
    out[id] = {
      kind: c.kind || 'house',
      weight: c.weight || 10,
      from: c.from || null,
      to: c.to || null,
      countries: c.countries || [],
      cap: c.cap || { n: 3, per: 'hour' },
      clickUrl: c.clickUrl,
      title: c.title || '',
      slots,
    };
  }
  return normalize({ v: version, updatedAt: now, campaigns: out }) || {};
}

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** Same ads? updatedAt is ignored, so a rebuild that changes nothing is not written. */
function sameFeed(a, b) {
  const na = normalize(a) || {};
  const nb = normalize(b) || {};
  return stable(na.campaigns || {}) === stable(nb.campaigns || {}) && na.v === nb.v;
}

module.exports = { APP_KEYS, buildFeed, sameFeed, normalize };
