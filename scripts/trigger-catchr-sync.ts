import { syncAll } from '../src/services/ad-spend.service.js';

async function main() {
  const started = Date.now();
  const result = await syncAll();
  console.log(JSON.stringify({ ms: Date.now() - started, ...result }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('sync failed:', err);
  process.exit(1);
});
