'use strict';
// Cloud Functions of the TI Apps own-ads system (phase A of ADS-PLAN.md).
//  - rebuildFeed     : every write under campaigns/ rebuilds feed/{app}
//  - republishFeed   : admin button "Republish feed"
//  - sendTestEmail   : admin checks that Resend and the tiapps.dev DNS records work

const { onValueWritten } = require('firebase-functions/v2/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const { APP_KEYS, buildFeed, sameFeed } = require('./lib/feed');
const { sendEmail } = require('./lib/email');

// The database is in europe-west1, so the Admin SDK needs its URL spelled out.
initializeApp({ databaseURL: 'https://tiapps-ads-default-rtdb.europe-west1.firebasedatabase.app' });

const REGION = 'europe-west1';
const ADMIN_UID = '5bCbdUU29cPtffTXwNJw5DzigSd2';

setGlobalOptions({ region: REGION, maxInstances: 5 });

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const MAIL_FROM = defineString('MAIL_FROM', { default: 'TI Apps <noreply@tiapps.dev>' });
const ADMIN_EMAIL = defineString('ADMIN_EMAIL', { default: 'todorilinov@googlemail.com' });

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
