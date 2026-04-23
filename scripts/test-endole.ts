import 'dotenv/config';
import { runCreditCheck, isEndoleConfigured } from '../src/integrations/endole/endole-client.js';

async function main() {
  const companyNumber = process.argv[2] || '00445790';
  const companyName = process.argv[3] || 'Test Company Ltd';

  console.log('─── Endole live test ───');
  console.log('Configured:', isEndoleConfigured());
  console.log('Sandbox mode:', process.env.ENDOLE_SANDBOX === 'true');
  console.log('App ID:', process.env.ENDOLE_APP_ID || '(missing)');
  console.log('App Key:', process.env.ENDOLE_APP_KEY ? '***set***' : '(missing)');
  console.log('Company:', companyNumber, '—', companyName);
  console.log();

  const started = Date.now();
  const report = await runCreditCheck(companyNumber, companyName);
  const ms = Date.now() - started;

  console.log('─── Result ───');
  console.log(JSON.stringify(report, null, 2));
  console.log();
  console.log(`Took ${ms}ms.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Endole test failed:', err);
  process.exit(1);
});
