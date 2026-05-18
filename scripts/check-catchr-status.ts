import { listPlatforms, listSources } from '../src/integrations/catchr/catchr-client.js';

const { platforms } = await listPlatforms(false);
const total = platforms.length;
const connected = platforms.filter((p) => p.connected).length;
console.log('=== Platforms ===');
console.log('total:', total, 'connected:', connected);
for (const p of platforms) {
  console.log(`  ${p.connected ? 'OK' : 'XX'}  ${p.name}`);
}

console.log('\n=== Sources by status ===');
const { sources } = await listSources({});
const byStatus = sources.reduce<Record<string, number>>((acc, s) => {
  const key = String(s.status ?? 'unknown');
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
console.log(byStatus);

console.log('\n=== Sources with non-ok status ===');
for (const s of sources) {
  if (String(s.status ?? '').toLowerCase() !== 'ok') {
    console.log(`  ${s.status ?? '?'}  ${s.platform ?? '?'}  ${s.name ?? '?'}`);
  }
}
process.exit(0);
