'use strict';
// Texts of the emails. Plain text; sendEmail wraps it in a simple HTML body.

const { APPS, SLOTS } = require('./spec');

const fmtDate = ms => new Date(ms).toISOString().slice(0, 10);
const fmtN = n => Number(n).toLocaleString('en');

/** The money and the impressions, for each format and in total. Old requests only have the impressions. */
function budgetLines(rec) {
  const b = rec.budget || {};
  const lines = [];
  for (const [app, m] of Object.entries(b.items || {})) {
    for (const [slot, it] of Object.entries(m || {})) {
      lines.push('  ' + (APPS[app] ? APPS[app].name : app) + ' · ' + (SLOTS[slot] ? SLOTS[slot].label : slot) + ': ' +
        Number(it.amount).toFixed(2) + ' ' + (b.currency || 'EUR') + ' → about ' + fmtN(it.impressions) + ' impressions');
    }
  }
  const total = b.amount != null ? Number(b.amount).toFixed(2) + ' ' + (b.currency || 'EUR') + ' for about ' : '';
  return lines.concat(['  Total: ' + total + fmtN(b.target) + ' impressions']).join('\n');
}

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
Budget:
${budgetLines(rec)}
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
Budget:
${budgetLines(rec)}
Requested start: ${fmtDate(rec.from)}

Review it here:
${adminUrl}

Reply to this email to write to the advertiser.`,
  };
}

const money = f => Number(f.amount).toFixed(2) + ' ' + f.currency;
const sign = '\nTI Apps\nhttps://tiapps.dev';

/** Approved: the advertiser can pay. */
function approvedEmail(rec, ref, statusUrl, payBy) {
  return {
    subject: 'Your ad is approved (' + ref + ')',
    text:
`Hi ${rec.advertiser.name},

Good news: your ad "${rec.title}" is approved.

Price: ${money(rec.final)} for ${fmtN(rec.budget.target)} impressions${rec.final.note ? '\nNote: ' + rec.final.note : ''}

To pay and start the campaign, open your status page and use the Pay button:
${statusUrl}

Please pay by ${fmtDate(payBy)}. After that date the approval expires and you would need to ask again.
We will email you as soon as the payment is received.
${sign}`,
  };
}

/** Rejected, with the reason. */
function rejectedEmail(rec, ref, statusUrl) {
  return {
    subject: 'About your ad request (' + ref + ')',
    text:
`Hi ${rec.advertiser.name},

We could not approve your ad "${rec.title}".

Reason: ${rec.review.rejectReason}

You can fix this and send a new version from your status page:
${statusUrl}
${sign}`,
  };
}

/** Changes needed before it can be approved. */
function changesEmail(rec, ref, statusUrl) {
  return {
    subject: 'Changes needed for your ad (' + ref + ')',
    text:
`Hi ${rec.advertiser.name},

Before we can approve your ad "${rec.title}" we need a few changes:

${rec.review.note}

You can update your request and upload new files from your status page:
${statusUrl}
${sign}`,
  };
}

/** Payment received. */
function paidEmail(rec, ref, statusUrl) {
  return {
    subject: 'Payment received (' + ref + ')',
    text:
`Hi ${rec.advertiser.name},

We received your payment of ${money(rec.final)}. Thank you!

Your ad "${rec.title}" will start around ${fmtDate(rec.from)}. We check every campaign before it goes live and we will email you when it does.

You can follow it here:
${statusUrl}
${sign}`,
  };
}

/** An approval nobody paid for. */
function expiredEmail(rec, ref) {
  return {
    subject: 'Your ad approval expired (' + ref + ')',
    text:
`Hi ${rec.advertiser.name},

Your ad "${rec.title}" was approved, but we did not receive the payment in time, so the approval expired.
If you still want to advertise, please send a new request at https://tiapps.dev/advertise.html.
${sign}`,
  };
}

/** To the admin: the advertiser sent a new version. */
function updatedAdminEmail(rec, ref, adminUrl) {
  const a = rec.advertiser;
  return {
    subject: 'Updated ad request ' + ref + ': ' + rec.title,
    text:
`${a.name} <${a.email}> sent a new version of the request and it is waiting for review again.

Reference: ${ref}
Ad: ${rec.title}
Link: ${rec.clickUrl}
Apps and formats:
${formatLines(rec)}
Budget:
${budgetLines(rec)}
Requested start: ${fmtDate(rec.from)}

Review it here:
${adminUrl}`,
  };
}

/** The campaign has shown everything that was paid for. */
function finishedEmail(rec, ref, statusUrl, delivered) {
  return {
    subject: 'Your campaign is finished (' + ref + ')',
    text:
`Hi ${rec.advertiser.name},

Your campaign "${rec.title}" has shown all the impressions you paid for (${fmtN(delivered)}). Thank you for advertising with us!

You can see the summary here:
${statusUrl}

If you would like to run another campaign, you can send a new request at https://tiapps.dev/advertise.html.
${sign}`,
  };
}

/** The code for the report. */
function codeEmail(rec, ref, code) {
  return {
    subject: 'Your TI Apps report code: ' + code,
    text:
`Hi ${rec.advertiser.name},

Your code for the report of "${rec.title}" is:

${code}

It works for 10 minutes. If you did not ask for it, you can ignore this email: nobody can open the report without it.
${sign}`,
  };
}

module.exports = { codeEmail, finishedEmail, receivedEmail, adminEmail, approvedEmail, rejectedEmail, changesEmail, paidEmail, expiredEmail, updatedAdminEmail };
