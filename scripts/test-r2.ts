import 'dotenv/config';
import {
  isR2Configured,
  uploadFile,
  getSignedDownloadUrl,
  deleteFile,
} from '../src/integrations/r2/r2-client.js';

async function main() {
  console.log('─── Cloudflare R2 live test ───');
  console.log('Configured:', isR2Configured());
  console.log('Bucket:', process.env.R2_BUCKET);
  console.log('Endpoint:', process.env.R2_ENDPOINT);
  console.log('Access Key ID:', process.env.R2_ACCESS_KEY_ID ? '***set***' : '(missing)');
  console.log('Secret Access Key:', process.env.R2_SECRET_ACCESS_KEY ? '***set***' : '(missing)');
  console.log();

  if (!isR2Configured()) {
    console.error('✗ R2 not configured — check .env values.');
    process.exit(1);
  }

  const key = `smoke-test-${Date.now()}.txt`;
  const body = `Stato R2 smoke test at ${new Date().toISOString()}\n`;

  console.log(`─── Upload misc/${key} (${body.length} bytes) ───`);
  const t0 = Date.now();
  const result = await uploadFile({
    folder: 'misc',
    key,
    body,
    contentType: 'text/plain',
  });
  console.log(`✓ Uploaded in ${Date.now() - t0}ms`);
  console.log('  fullKey:', result.key);
  console.log('  bucket: ', result.bucket);
  console.log('  size:   ', result.size);
  console.log();

  console.log('─── Generate signed download URL (15 min TTL) ───');
  const t1 = Date.now();
  const downloadUrl = await getSignedDownloadUrl({
    folder: 'misc',
    key,
    expiresInSeconds: 900,
  });
  console.log(`✓ Signed URL in ${Date.now() - t1}ms`);
  console.log('  ', downloadUrl.slice(0, 120) + '…');
  console.log();

  console.log('─── Fetch the signed URL to verify it serves the upload ───');
  const t2 = Date.now();
  const fetched = await fetch(downloadUrl);
  if (!fetched.ok) {
    console.error(`✗ Fetch failed: HTTP ${fetched.status}`);
    process.exit(1);
  }
  const fetchedBody = await fetched.text();
  console.log(`✓ Fetched in ${Date.now() - t2}ms — HTTP ${fetched.status}`);
  console.log('  body matches:', fetchedBody === body ? '✓ yes' : '✗ NO');
  console.log('  first 80 chars:', JSON.stringify(fetchedBody.slice(0, 80)));
  console.log();

  console.log('─── Delete test object ───');
  const t3 = Date.now();
  await deleteFile('misc', key);
  console.log(`✓ Deleted in ${Date.now() - t3}ms`);
  console.log();

  console.log('✓ Cloudflare R2 integration is live.');
  process.exit(0);
}

main().catch((err) => {
  console.error('R2 test failed:', err?.message ?? err);
  if (err?.$metadata) console.error('  AWS metadata:', err.$metadata);
  process.exit(1);
});
