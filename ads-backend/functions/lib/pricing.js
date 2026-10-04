'use strict';
// The price list (ADS-PLAN.md, section 9). The admin edits it in admin-ads.html → Prices and it is
// stored in the database under pricing/. The form reads it to show "how many impressions"; the server
// always works the price out again from it, so numbers coming from a browser are never trusted.

const { APPS } = require('./spec');

/** Used when pricing/ has not been saved yet, and for the missing parts of a saved list. */
const DEFAULT_PRICING = {
  currency: 'EUR',
  minBudget: 10,
  maxBudget: 5000,
  presets: [10, 25, 50, 100, 250],
  items: {
    worldradio:   { banner: { cpm: 1.5, on: true }, mrec: { cpm: 3, on: true }, fullscreen: { cpm: 10, on: true } },
    tvdsp:        { banner: { cpm: 1.2, on: true } },
    fakelocation: { banner: { cpm: 1,   on: true } },
  },
};

const num = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
};

/** Whatever is in the database becomes a complete, valid price list. */
function normalizePricing(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_PRICING;
  const minBudget = num(r.minBudget, 1, 100000, d.minBudget);
  const maxBudget = Math.max(minBudget, num(r.maxBudget, 1, 1000000, d.maxBudget));
  let presets = Array.isArray(r.presets) ? r.presets.map(Number).filter(n => Number.isFinite(n) && n >= minBudget && n <= maxBudget) : [];
  presets = [...new Set(presets)].sort((a, b) => a - b).slice(0, 8);
  if (!presets.length) presets = d.presets.filter(n => n >= minBudget && n <= maxBudget);
  const items = {};
  for (const [app, spec] of Object.entries(APPS)) {
    items[app] = {};
    for (const slot of spec.slots) {
      const got = r.items && r.items[app] && r.items[app][slot];
      items[app][slot] = {
        cpm: num(got && got.cpm, 0.01, 1000, d.items[app][slot].cpm),
        on: got && typeof got.on === 'boolean' ? got.on : true,
      };
    }
  }
  return { currency: 'EUR', minBudget, maxBudget, presets, items };
}

/** How many impressions an amount buys at [cpm] euro per 1000, rounded down to whole hundreds. */
const impressionsFor = (amount, cpm) => Math.floor(amount / cpm * 1000 / 100) * 100;

const round2 = n => Math.round(n * 100) / 100;

module.exports = { DEFAULT_PRICING, normalizePricing, impressionsFor, round2 };
