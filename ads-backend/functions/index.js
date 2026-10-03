'use strict';
// Cloud Functions of the TI Apps own-ads system (phase A of ADS-PLAN.md).
//  - rebuildFeed     : every write under campaigns/ rebuilds feed/{app}
//  - republishFeed   : admin button "Republish feed"
//  - sendTestEmail   : admin checks that Resend and the tiapps.dev DNS records work
// Phase B:
//  - submit          : advertise.html sends a request here; it is checked, saved and both sides get an email
//  - cleanupUploads  : deletes abandoned files in uploads/ every day
// Phase C:
//  - adminReview     : approve (price + payment link), reject (reason) or send back (note); the advertiser gets an email
//  - adminMarkPaid   : payment arrived: files are copied, a paused campaign is created
//  - statusGet       : ad-status.html asks for the state of a request (id + secret token)
//  - statusResubmit  : the advertiser sends a new version of a request that was sent back or rejected
//  - expireUnpaid    : approvals nobody paid within 14 days expire

const { onValueWritten } = require('firebase-functions/v2/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getStorage } = require('firebase-admin/storage');
const crypto = require('crypto');

const { APP_KEYS, buildFeed, sameFeed } = require('./lib/feed');
const { sendEmail } = require('./lib/email');
const { processSubmission, processResubmission, InvalidRequest, RateLimited, NotAllowed } = require('./lib/submit');
const { review, markPaid, expireUnpaid, statusGet, ReviewError } = require('./lib/review');

// The database is in europe-west1, so the Admin SDK needs its URL spelled out.
initializeApp({
  databaseURL: 'https://tiapps-ads-default-rtdb.europe-west1.firebasedatabase.app',
  storageBucket: 'tiapps-ads.firebasestorage.app',
});

const REGION = 'europe-west1';
const ADMIN_UID = '5bCbdUU29cPtffTXwNJw5DzigSd2';

setGlobalOptions({ region: REGION, maxInstances: 5 });

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const MAIL_FROM = defineString('MAIL_FROM', { default: 'TI Apps <noreply@tiapps.dev>' });
const ADMIN_EMAIL = defineString('ADMIN_EMAIL', { default: 'todorilinov@googlemail.com' });
// 'true' once App Check (reCAPTCHA) is set up on advertise.html: requests without a valid token are then refused.
const APPCHECK_REQUIRED = defineString('APPCHECK_REQUIRED', { default: 'false' });

function requireAdmin(request) {
  if (!request.auth || request.auth.uid !== ADMIN_UID) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }
}

/** Rebuilds feed/{app} from campaigns/. Writes only what changed. Returns the apps that were written. */
async function rebuildFeeds() {
  const db = getDatabase();
  const campaigns = (await db.ref('campaigns').get()).val() || {};
  const now = Date.now();
  const written = [];
  await Promise.all(APP_KEYS.map(async app => {
    const next = buildFeed(campaigns, app, now);
    const cur = (await db.ref('feed/' + app).get()).val();
    if (cur && sameFeed(cur, next)) return;
    // An empty feed is stored as { v: 1, updatedAt } — the apps read that as "no ads".
    await db.ref('feed/' + app).set(next.v ? next : { v: 1, updatedAt: now });
    written.push(app);
  }));
  return written;
}

exports.rebuildFeed = onValueWritten(
  { ref: '/campaigns/{cid}', instance: 'tiapps-ads-default-rtdb', region: REGION },
  async event => {
    try {
      const written = await rebuildFeeds();
      logger.info('rebuildFeed ok', { cid: event.params.cid, written });
    } catch (e) {
      logger.error('rebuildFeed failed', { cid: event.params.cid, error: e.message });
      throw e;
    }
  }
);

// Callable functions are called from the browser (tiapps.dev), so they must be publicly invocable
// (Cloud Run IAM) and answer the CORS preflight. Who may do what is checked inside (requireAdmin).
const CALLABLE = { invoker: 'public', cors: true };

exports.republishFeed = onCall(CALLABLE, async request => {
  requireAdmin(request);
  try {
    const written = await rebuildFeeds();
    return { written };
  } catch (e) {
    logger.error('republishFeed failed', e);
    throw new HttpsError('internal', 'Feed rebuild failed: ' + e.message);
  }
});

exports.sendTestEmail = onCall({ ...CALLABLE, secrets: [RESEND_API_KEY] }, async request => {
  requireAdmin(request);
  try {
    const id = await sendEmail({
      apiKey: RESEND_API_KEY.value(),
      from: MAIL_FROM.value(),
      to: ADMIN_EMAIL.value(),
      subject: 'TI Apps ads: test email',
      text: 'If you can read this, Resend and the tiapps.dev sending domain work.\n\nSent ' + new Date().toISOString(),
    });
    return { id, to: ADMIN_EMAIL.value() };
  } catch (e) {
    logger.error('sendTestEmail failed', e);
    throw new HttpsError('internal', e.message);
  }
});

/** Everything the logic in lib/ needs from the outside. */
function makeCtx(request) {
  const fwd = request && request.rawRequest && request.rawRequest.headers && request.rawRequest.headers['x-forwarded-for'];
  const ip = (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || (request && request.rawRequest && request.rawRequest.ip) || '';
  const bucket = getStorage().bucket();
  return {
    now: Date.now(),
    ip,
    db: getDatabase(),
    bucket,
    bucketName: bucket.name,
    sendMail: m => sendEmail({ apiKey: RESEND_API_KEY.value(), from: MAIL_FROM.value(), ...m }),
    newToken: () => crypto.randomBytes(16).toString('base64url'),
    adminEmail: ADMIN_EMAIL.value(),
    baseUrl: 'https://tiapps.dev',
    log: (msg, extra) => logger.warn(msg, extra),
  };
}

/** Runs [fn] and turns the errors of lib/ into the errors the browser understands. */
async function guarded(name, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InvalidRequest) throw new HttpsError('invalid-argument', e.message, { errors: e.errors });
    if (e instanceof RateLimited) throw new HttpsError('resource-exhausted', e.message);
    if (e instanceof NotAllowed || e instanceof ReviewError) throw new HttpsError(e.code, e.message);
    logger.error(name + ' failed', { error: e.message, stack: e.stack });
    throw new HttpsError('internal', 'Something went wrong on our side. Please try again later.');
  }
}

function requireAppCheck(request) {
  if (APPCHECK_REQUIRED.value() === 'true' && !request.app) {
    throw new HttpsError('failed-precondition', 'The request could not be verified. Please reload the page and try again.');
  }
}

const PUBLIC_CALL = { ...CALLABLE, secrets: [RESEND_API_KEY], timeoutSeconds: 120, memory: '512MiB' };

exports.submit = onCall(PUBLIC_CALL, request => {
  requireAppCheck(request);
  return guarded('submit', () => processSubmission(request.data, makeCtx(request)));
});

exports.statusResubmit = onCall(PUBLIC_CALL, request => {
  requireAppCheck(request);
  return guarded('statusResubmit', () => processResubmission(request.data, makeCtx(request)));
});

exports.statusGet = onCall({ ...CALLABLE, memory: '256MiB' }, request => {
  return guarded('statusGet', () => statusGet(request.data, makeCtx(request)));
});

exports.adminReview = onCall({ ...CALLABLE, secrets: [RESEND_API_KEY] }, request => {
  requireAdmin(request);
  return guarded('adminReview', () => review(request.data || {}, makeCtx(request)));
});

exports.adminMarkPaid = onCall({ ...CALLABLE, secrets: [RESEND_API_KEY], timeoutSeconds: 120, memory: '512MiB' }, request => {
  requireAdmin(request);
  return guarded('adminMarkPaid', () => markPaid(request.data || {}, makeCtx(request)));
});

exports.expireUnpaid = onSchedule({ schedule: 'every day 04:00', timeZone: 'UTC', secrets: [RESEND_API_KEY] }, async () => {
  const n = await expireUnpaid(makeCtx(null));
  logger.info('expireUnpaid', { expired: n });
});

// Files uploaded by the form but never submitted (or already moved) must not pile up.
exports.cleanupUploads = onSchedule({ schedule: 'every day 03:30', timeZone: 'UTC' }, async () => {
  const [files] = await getStorage().bucket().getFiles({ prefix: 'uploads/' });
  const limit = Date.now() - 24 * 3600 * 1000;
  let deleted = 0;
  for (const f of files) {
    if (Date.parse(f.metadata.timeCreated) < limit) {
      await f.delete().catch(() => {});
      deleted++;
    }
  }
  logger.info('cleanupUploads', { found: files.length, deleted });
});
