import 'dotenv/config';
import {
  isSignNowConfigured,
  createEnvelope,
  getEnvelopeStatus,
} from '../src/integrations/signnow/signnow-client.js';

async function main() {
  const signerEmail = process.argv[2] || 'yash.c@octogle.com';
  const signerName = process.argv[3] || 'Yash Chavan';

  console.log('─── SignNow live test ───');
  console.log('Configured:', isSignNowConfigured());
  console.log('Base URL:', process.env.SIGNNOW_BASE_URL || 'https://api-eval.signnow.com (default sandbox)');
  console.log('Client ID:', process.env.SIGNNOW_CLIENT_ID ? '***set***' : '(missing)');
  console.log('Client Secret:', process.env.SIGNNOW_CLIENT_SECRET ? '***set***' : '(missing)');
  console.log('Username:', process.env.SIGNNOW_USERNAME || '(missing)');
  console.log('Password:', process.env.SIGNNOW_PASSWORD ? '***set***' : '(missing)');
  console.log('Signer:', signerName, `<${signerEmail}>`);
  console.log();

  if (!isSignNowConfigured()) {
    console.error('✗ Missing one or more SignNow env vars — cannot proceed.');
    console.error('  Required: SIGNNOW_CLIENT_ID, SIGNNOW_CLIENT_SECRET, SIGNNOW_USERNAME, SIGNNOW_PASSWORD');
    process.exit(1);
  }

  console.log('─── Sending envelope (minimal PDF) ───');
  const minimalPdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n0000000101 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n147\n%%EOF';

  const started = Date.now();
  try {
    const envelope = await createEnvelope({
      signerEmail,
      signerName,
      documentName: 'Stato Integration Test Agreement.pdf',
      documentBase64: Buffer.from(minimalPdf).toString('base64'),
    });
    const ms = Date.now() - started;

    console.log('─── Result ───');
    console.log(JSON.stringify(envelope, null, 2));
    console.log();
    console.log(`✓ Envelope created in ${ms}ms. Signer will get an email.`);

    console.log();
    console.log('─── Polling status ───');
    const status = await getEnvelopeStatus(envelope.envelopeId);
    console.log('Current status:', status);
    console.log('(Will change to "completed" once the signer actually signs)');
    process.exit(0);
  } catch (err) {
    const e = err as Error;
    console.error('✗ SignNow test failed:', e.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('SignNow test crashed:', err);
  process.exit(1);
});
