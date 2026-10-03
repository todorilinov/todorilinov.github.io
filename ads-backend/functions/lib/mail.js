'use strict';
// Texts of the emails. Plain text; sendEmail wraps it in a simple HTML body.

const { APPS, SLOTS } = require('./spec');

const fmtDate = ms => new Date(ms).toISOString().slice(0, 10);
const fmtN = n => Number(n).toLocaleString('en');

function formatLines(rec) {
  const lines = [];
  for (const [app, slots] of Object.entries(rec.slots || {})) {
    const names = Object.keys(slots).map(s => SLOTS[s] ? SLOTS[s].label : s).join(', ');
    lines.push('  ' + (APPS[app] ? APPS[app].name : app) + ': ' + names);
  }
  return lines.join('\n');
}

/** Sent to the advertiser right after the request is received. */
function receivedEmail(rec, ref, statusUrl) {
  return {
    subject: 'We received your ad request (' + ref + ')',
    text:
`Hi ${rec.advertiser.name},

Thank you for your request to advertise with TI Apps. We review every ad by hand, usually within 2 working days, and we will email you the result.

Reference: ${ref}
Ad: ${rec.title}
Apps and formats:
${formatLines(rec)}
Budget: ${fmtN(rec.budget.target)} impressions
Requested start: ${fmtDate(rec.from)}

You can follow the status of your request here:
${statusUrl}

Keep this email: the link above is private. Anyone who has it can see the status of your request.

If you did not make this request, you can ignore this email.

TI Apps
https://tiapps.dev`,
  };
}

/** Sent to the admin when a request arrives. */
function adminEmail(rec, ref, adminUrl) {
  const a = rec.advertiser;
  return {
    subject: 'New ad request ' + ref + ': ' + rec.title,
    text:
`A new ad request is waiting for review.

Reference: ${ref}
From: ${a.name}${a.company ? ' (' + a.company + ')' : ''} <${a.email}>, ${a.country}${a.vat ? ', VAT ' + a.vat : ''}
Ad: ${rec.title}
${rec.description ? rec.description + '\n' : ''}Link: ${rec.clickUrl}
Apps and formats:
${formatLines(rec)}
Countries: ${rec.countries && rec.countries.length ? rec.countries.join(', ') : 'all'}
Budget: ${fmtN(rec.budget.target)} impressions
Requested start: ${fmtDate(rec.from)}

Review it here:
${adminUrl}

Reply to this email to write to the advertiser.`,
  };
}

module.exports = { receivedEmail, adminEmail };
