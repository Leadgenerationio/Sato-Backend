import 'dotenv/config';
import { sendEmail, isResendConfigured } from '../src/integrations/resend/resend-client.js';

async function main() {
  const to = process.argv[2] || 'yash.c@octogle.com';

  console.log('─── Resend live test ───');
  console.log('Configured:', isResendConfigured());
  console.log('API key:', process.env.RESEND_API_KEY ? '***set***' : '(missing)');
  console.log('From:', `${process.env.RESEND_FROM_NAME} <${process.env.RESEND_FROM_EMAIL}>`);
  console.log('To:', to);
  console.log();

  if (!isResendConfigured()) {
    console.error('✗ RESEND_API_KEY not set — cannot proceed.');
    process.exit(1);
  }

  const started = Date.now();
  try {
    const result = await sendEmail({
      to,
      subject: 'Stato Resend integration test',
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 480px; padding: 24px;">
          <h2 style="color: #0f172a;">Stato — Resend works ✓</h2>
          <p>This is a test email from your local Stato backend.</p>
          <p>If you're reading this in your inbox, the Resend integration is sending real emails.</p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="color: #64748b; font-size: 13px;">Sent at ${new Date().toISOString()}</p>
        </div>
      `,
      text: 'Stato — Resend works. Sent at ' + new Date().toISOString(),
    });
    const ms = Date.now() - started;

    console.log('─── Result ───');
    console.log(JSON.stringify(result, null, 2));
    console.log();
    console.log(`✓ Sent in ${ms}ms. Check the Resend dashboard and your inbox.`);
    process.exit(0);
  } catch (err) {
    const e = err as Error;
    console.error('✗ Resend send failed:', e.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Resend test crashed:', err);
  process.exit(1);
});
