import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { creatives } from '../db/schema/creatives.js';

// Retest R3 (R2-1): on the live site the library list showed "File missing" for 3 creatives whose files
// exist. They were uploaded before the library, into R2's misc/ folder; the list signed creatives/<key> for
// every row, so each link answered NoSuchKey while the detail endpoint (which resolves the folder from the
// stored file_url) worked.
const BIZ = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
let token = ''; let clientId = ''; const ids: string[] = [];

beforeAll(async () => {
  const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@stato.app', password: 'owner123' });
  token = res.body.data.tokens.accessToken;
  const [c] = await db.insert(clients).values({ businessId: BIZ, companyName: `Yash Test Legacy Folder ${Date.now()}`, status: 'active' }).returning();
  clientId = c!.id;
  const mk = async (name: string, fileUrl: string, r2Key: string) => {
    const [r] = await db.insert(creatives).values({ clientId, name, type: 'image', fileUrl, r2Key, contentType: 'image/png' }).returning();
    ids.push(r!.id); return r!.id;
  };
  await mk('Yash Legacy misc', 'https://acct.r2.cloudflarestorage.com/stato-production/misc/1779836141648-legacy.png', '1779836141648-legacy.png');
  await mk('Yash Library creatives', 'https://acct.r2.cloudflarestorage.com/stato-production/creatives/1779999999999-lib.png', '1779999999999-lib.png');
  await mk('Yash Key only', 'creatives-nofolder', 'orphan-key.png');
});
afterAll(async () => {
  for (const id of ids) await db.delete(creatives).where(eq(creatives.id, id));
  await db.delete(clients).where(eq(clients.id, clientId));
});

describe('library list signs the folder the file lives in', () => {
  it('legacy upload (misc/) and library upload (creatives/) each get their own folder', async () => {
    const res = await request(app).get(`/api/v1/creatives?clientId=${clientId}&limit=50`).set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.data.creatives.map((c: { name: string; fileUrl: string | null }) => [c.name, c.fileUrl]));
    expect(by['Yash Legacy misc']).toContain('/misc/1779836141648-legacy.png');
    expect(by['Yash Legacy misc']).not.toContain('/creatives/1779836141648-legacy.png');
    expect(by['Yash Library creatives']).toContain('/creatives/1779999999999-lib.png');
  });

  it('a row with no recognisable folder falls back to misc/ like the detail and portal paths', async () => {
    const res = await request(app).get(`/api/v1/creatives?clientId=${clientId}&limit=50`).set({ Authorization: `Bearer ${token}` });
    const row = res.body.data.creatives.find((c: { name: string }) => c.name === 'Yash Key only');
    expect(row.fileUrl).toContain('/misc/orphan-key.png');
  });
});
