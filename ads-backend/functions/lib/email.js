'use strict';
// Sends mail through Resend (https://resend.com/docs/api-reference/emails/send-email).

const RESEND_URL = 'https://api.resend.com/emails';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {{apiKey:string, from:string, to:string|string[], subject:string, text:string, html?:string, replyTo?:string}} m
 * @returns {Promise<string>} Resend message id
 */
async function sendEmail(m) {
  if (!m.apiKey) throw new Error('RESEND_API_KEY is not set');
  const body = {
    from: m.from,
    to: Array.isArray(m.to) ? m.to : [m.to],
    subject: m.subject,
    text: m.text,
    html: m.html || '<pre style="font:14px/1.5 sans-serif;white-space:pre-wrap">' + esc(m.text) + '</pre>',
  };
  if (m.replyTo) body.reply_to = m.replyTo;
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + m.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Resend ' + res.status + ': ' + (data.message || JSON.stringify(data)));
  return data.id;
}

module.exports = { sendEmail, esc };
