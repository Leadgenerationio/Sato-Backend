import { listPlatforms, listSources } from '../src/integrations/catchr/catchr-client.js';

const { platforms } = await listPlatforms(false);
const total = platforms.length;
const connected = platforms.filter((p) => p.connected).length;
console.log('=== Platforms ===');
console.log('total:', total, 'connected:', connected);
for (const p of platforms) {
  console.log(`  ${p.connected ? 'OK' : 'XX'}  ${p.name}`);
}

console.log('\n=== Sources (top-level only — Catchr source shape varies by platform) ===');
const { sources } = await listSources({});
// Cast to any since the discriminated-union shape doesn't expose `status` at
// the top level — this script just wants a flat dump for diagnostic use.
const flat = sources as unknown as Array<Record<string, unknown>>;
for (const s of flat.slice(0, 20)) {
  console.log(`  platform=${s.platform ?? '?'}  name=${s.name ?? '?'}  status=${s.status ?? '?'}`);
}
process.exit(0);
