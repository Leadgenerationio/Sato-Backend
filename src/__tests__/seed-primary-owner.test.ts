import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users } from '../db/schema/users.js';
import { seedDefaultUsers } from '../data/users.js';

// Staging was seeded before the primary-owner flag existed, so nobody was the primary owner and no Owner user could
// be created. The seed now repairs that, once, without touching anything else.
describe('seedDefaultUsers heals a missing primary owner', () => {
  afterAll(async () => { await db.update(users).set({ isPrimaryOwner: true }).where(eq(users.email, 'owner@stato.app')); });

  it('marks the seed owner primary when nobody is, keeps the password, and leaves an existing primary owner alone', async () => {
    const [before] = await db.select().from(users).where(eq(users.email, 'owner@stato.app'));
    expect(before).toBeDefined();
    await db.update(users).set({ isPrimaryOwner: false });                      // the staging state: no primary owner at all
    await seedDefaultUsers();
    const [healed] = await db.select().from(users).where(eq(users.email, 'owner@stato.app'));
    expect(healed!.isPrimaryOwner).toBe(true);
    expect(healed!.passwordHash).toBe(before!.passwordHash);                    // the (changed) password is untouched
    expect((await db.select().from(users).where(eq(users.isPrimaryOwner, true))).map((u) => u.email)).toEqual(['owner@stato.app']);

    // once someone is the primary owner, a later seed does not move it
    await db.update(users).set({ isPrimaryOwner: false }).where(eq(users.email, 'owner@stato.app'));
    await db.update(users).set({ isPrimaryOwner: true }).where(eq(users.email, 'finance@stato.app'));
    await seedDefaultUsers();
    expect((await db.select().from(users).where(eq(users.isPrimaryOwner, true))).map((u) => u.email)).toEqual(['finance@stato.app']);
    await db.update(users).set({ isPrimaryOwner: false }).where(eq(users.email, 'finance@stato.app'));
  });
});
