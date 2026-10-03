'use strict';
// What can be sold and how a request from the public form is checked (ADS-PLAN.md, sections 5, 6, 8, 12).
// Pure functions, no Firebase: tested in test/submission.test.js.

const { imageSize } = require('image-size');

const APPS = {
  worldradio:   { name: 'WorldRadio',    slots: ['banner', 'mrec', 'fullscreen'] },
  tvdsp:        { name: 'TV DSP Center', slots: ['banner'] },
  fakelocation: { name: 'FakeLocation',  slots: ['banner'] },
};

// Same sizes as admin-ads.html. HTML5 is not accepted from the public (plan, section 12).
const SLOTS = {
  banner:     { label: 'Banner',           w: 640, h: 100,  types: ['image', 'gif'] },
  mrec:       { label: 'Medium rectangle', w: 600, h: 500,  types: ['image', 'gif'] },
  fullscreen: { label: 'Full screen',      w: 720, h: 1280, types: ['video', 'image'] },
};

const MAX_BYTES = { image: 1024 * 1024, gif: 2 * 1024 * 1024, video: 6 * 1024 * 1024 };
const EXT = { png: 'png', webp: 'webp', jpg: 'jpg', gif: 'gif', mp4: 'mp4' };
const MIME = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', gif: 'image/gif', mp4: 'video/mp4' };

const MIN_LEAD_DAYS = 3;
const MAX_LEAD_DAYS = 365;
const MIN_IMPRESSIONS = 10000;
const MAX_IMPRESSIONS = 10000000;
const DAY_MS = 86400000;

const UPLOAD_PATH = /^uploads\/[A-Za-z0-9_-]{16,40}\/[A-Za-z0-9._-]{1,80}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ISO2 = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Looks at the first bytes of a file and says what it really is.
 * @param {Buffer} buf  the whole file for images and GIFs, at least the first 12 bytes for MP4
 * @returns {{kind:'image'|'gif'|'video', ext:string, mime:string, w?:number, h?:number}|null}
 */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') {
    return { kind: 'video', ext: 'mp4', mime: MIME.mp4 };
  }
  try {
    const s = imageSize(buf);
    if (!s || !EXT[s.type]) return null;
    return { kind: s.type === 'gif' ? 'gif' : 'image', ext: EXT[s.type], mime: MIME[s.type], w: s.width, h: s.height };
  } catch (_) {
    return null;
  }
}

/** Does this file fit the slot? Returns an error message or null. */
function checkFile(slot, info, size) {
  const spec = SLOTS[slot];
  if (!info) return 'The file is not a supported image, GIF or MP4 video.';
  if (!spec.types.includes(info.kind)) {
    return spec.label + ' accepts ' + spec.types.map(t => ({ image: 'an image', gif: 'a GIF', video: 'an MP4 video' }[t])).join(' or ') + '.';
  }
  if (size > MAX_BYTES[info.kind]) {
    return 'The file is too large (' + (MAX_BYTES[info.kind] / 1048576) + ' MB at most for ' +
      { image: 'images', gif: 'GIFs', video: 'videos' }[info.kind] + ').';
  }
  if (info.kind !== 'video' && (info.w !== spec.w || info.h !== spec.h)) {
    return 'The size must be exactly ' + spec.w + '×' + spec.h + ' px (this one is ' + info.w + '×' + info.h + ').';
  }
  return null;
}

// One-line fields: control characters (new lines, tabs) are turned into spaces, so a title can never break an email subject.
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max + 1) : '');
const para = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max + 1) : '');

/** Midnight UTC of the day [ms] falls in. */
const dayStart = ms => Math.floor(ms / DAY_MS) * DAY_MS;

/**
 * Checks the fields of a request. Files are checked separately (they need to be read).
 * @returns {{errors:{field:string,msg:string}[], value:object}}
 */
function validateInput(input, nowMs) {
  const errors = [];
  const err = (field, msg) => errors.push({ field, msg });
  const d = input && typeof input === 'object' ? input : {};
  const adv = d.advertiser || {};
  const ad = d.ad || {};

  const name = str(adv.name, 80);
  if (!name || name.length > 80) err('name', 'Enter your name (80 characters at most).');
  const company = str(adv.company, 80);
  if (company.length > 80) err('company', 'The company name is too long (80 characters at most).');
  const email = str(adv.email, 120);
  if (!email || email.length > 120 || !EMAIL.test(email)) err('email', 'Enter a valid email address.');
  const country = str(adv.country, 2).toUpperCase();
  if (!ISO2.test(country)) err('country', 'Choose your country.');
  const vat = str(adv.vat, 30);
  if (vat.length > 30) err('vat', 'The VAT number is too long.');

  const title = str(ad.title, 60);
  if (!title || title.length > 60) err('title', 'Enter a title (60 characters at most).');
  const description = para(ad.description, 300);
  if (description.length > 300) err('description', 'The description is too long (300 characters at most).');
  const clickUrl = str(ad.clickUrl, 300);
  if (!clickUrl || clickUrl.length > 300 || !(clickUrl.startsWith('https://') || clickUrl.startsWith('market://')) || /\s/.test(clickUrl)) {
    err('clickUrl', 'Enter a link that starts with https:// (or market:// for Google Play).');
  }

  // Apps and files: { app: { slot: { path } } }
  const files = [];
  const apps = d.apps && typeof d.apps === 'object' ? d.apps : {};
  for (const [app, slots] of Object.entries(apps)) {
    if (!APPS[app]) { err('apps', 'Unknown app: ' + app); continue; }
    let n = 0;
    for (const [slot, f] of Object.entries(slots || {})) {
      if (!APPS[app].slots.includes(slot)) { err('apps', APPS[app].name + ' has no ' + slot + ' format.'); continue; }
      const path = f && typeof f.path === 'string' ? f.path : '';
      if (!UPLOAD_PATH.test(path)) { err('file:' + app + '/' + slot, 'The upload is missing or invalid, please add the file again.'); continue; }
      files.push({ app, slot, path });
      n++;
    }
    if (!n) err('app:' + app, 'Add at least one file for ' + APPS[app].name + ', or untick it.');
  }
  if (!Object.keys(apps).length) err('apps', 'Choose at least one app.');

  let countries = [];
  if (d.countries != null) {
    if (!Array.isArray(d.countries) || d.countries.length > 250) {
      err('countries', 'The country list is invalid.');
    } else {
      countries = [...new Set(d.countries.map(c => str(c, 2).toUpperCase()))];
      if (countries.some(c => !ISO2.test(c))) { err('countries', 'The country list is invalid.'); countries = []; }
    }
  }

  let from = 0;
  const date = str(d.startDate, 10);
  if (!DATE.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) {
    err('startDate', 'Choose a start date.');
  } else {
    from = Date.parse(date + 'T00:00:00Z');
    const today = dayStart(nowMs);
    if (from < today + MIN_LEAD_DAYS * DAY_MS) err('startDate', 'The start date must be at least ' + MIN_LEAD_DAYS + ' days from today, so we can review the ad.');
    if (from > today + MAX_LEAD_DAYS * DAY_MS) err('startDate', 'The start date is too far ahead.');
  }

  const target = Number(d.budget && d.budget.target);
  if (!Number.isInteger(target) || target < MIN_IMPRESSIONS || target > MAX_IMPRESSIONS) {
    err('target', 'Choose between ' + MIN_IMPRESSIONS.toLocaleString('en') + ' and ' + MAX_IMPRESSIONS.toLocaleString('en') + ' impressions.');
  }

  if (d.terms !== true) err('terms', 'You need to accept the advertising terms to continue.');

  return {
    errors,
    value: {
      advertiser: { name, company, email, country, vat },
      ad: { title, description, clickUrl },
      files, countries, from,
      budget: { model: 'impressions', target },
      apps: Object.keys(apps),
    },
  };
}

module.exports = {
  APPS, SLOTS, MAX_BYTES, MIN_LEAD_DAYS, MIN_IMPRESSIONS, MAX_IMPRESSIONS, UPLOAD_PATH,
  sniff, checkFile, validateInput,
};
