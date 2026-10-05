'use strict';
// Checks a Firebase App Check token that a phone app sends with its counters (ADS-PLAN.md, section 11).
//
// The apps have their own Firebase projects (WorldRadio, TV DSP Center, FakeLocation), so their App Check
// tokens are issued by those projects, not by tiapps-ads. The Admin SDK can only check tokens of its own
// project, therefore the token (a signed JWT) is checked here against Google's public keys, as described in
// "Verify App Check tokens from a custom backend": signature, expiry, issuer and audience must belong to the
// project of the app that sent the counters.

const { createRemoteJWKSet, jwtVerify } = require('jose');

/** Project number of every app's own Firebase project (from its google-services.json). Not secret. */
const APP_PROJECTS = {
  worldradio: '311173752553',
  tvdsp: '845731119367',
  fakelocation: '462026876387',
};

const JWKS_URL = new URL('https://firebaseappcheck.googleapis.com/v1/jwks');
let jwks = null;

/**
 * @param {string} token  the App Check token
 * @param {string} app    which app says it is sending: worldradio | tvdsp | fakelocation
 * @param {function} [keys]  the key set (tests give their own)
 * @returns {Promise<boolean>} true only for a valid token of that app's project
 */
async function verifyAppCheck(token, app, keys) {
  const project = APP_PROJECTS[app];
  if (!project || typeof token !== 'string' || token.length < 50 || token.length > 4000) return false;
  try {
    keys = keys || jwks || (jwks = createRemoteJWKSet(JWKS_URL));
    const { payload, protectedHeader } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: 'https://firebaseappcheck.googleapis.com/' + project,
    });
    if (protectedHeader.typ && protectedHeader.typ !== 'JWT') return false;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    return aud.includes('projects/' + project) && typeof payload.sub === 'string' && payload.sub.length > 0;
  } catch (_) {
    return false;
  }
}

module.exports = { verifyAppCheck, APP_PROJECTS };
