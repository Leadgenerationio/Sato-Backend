/**
 * One-off: send the branded portal welcome email to a test recipient.
 *
 * Usage (key never needs committing):
 *   RESEND_API_KEY=re_xxx \
 *   RESEND_FROM_EMAIL=onboarding@resend.dev \
 *   RESEND_FROM_NAME='leadgeneration.io' \
 *   FRONTEND_URL=https://leadgenerationio.stato.tech \
 *   npx tsx scripts/send-welcome-test.ts yash.c@octogle.com
 *
 * Notes:
 * - Without a verified Resend domain you can only send from onboarding@resend.dev
 *   and only TO your own Resend account email. For production client sends,
 *   verify the sending domain in Resend (DNS) and set RESEND_FROM_EMAIL to it.
 */
import { sendEmail, isResendConfigured } from '../src/integrations/resend/resend-client.js';
import { templates, renderEmailHtml, renderEmailText } from '../src/integrations/resend/resend-templates.js';

const to = process.argv[2] || 'yash.c@octogle.com';
const brandName = process.env.PORTAL_BRAND_NAME || 'leadgeneration.io';
const loginUrl =
  (process.env.FRONTEND_URL || 'https://leadgenerationio.stato.tech').replace(/\/$/, '') + '/login?welcome=1';

const tpl = templates.portalWelcome({ name: 'Yash', email: to, loginUrl, brandName });

console.log(`Resend configured: ${isResendConfigured()} | sending to: ${to} | brand: ${brandName}`);

const res = await sendEmail({
  to,
  subject: tpl.subject,
  html: renderEmailHtml(tpl),
  text: renderEmailText(tpl),
});

console.log('Result:', JSON.stringify(res));
