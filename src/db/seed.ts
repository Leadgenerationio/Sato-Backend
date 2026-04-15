import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import bcryptjs from 'bcryptjs';
import { businesses, users, clients } from './schema/index.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = postgres(connectionString);
const db = drizzle(client);

async function seed() {
  console.log('Seeding...');

  // 1. Business
  const [biz] = await db.insert(businesses).values({
    name: 'leadgeneration.io',
    slug: 'leadgeneration',
    colour: '#171717',
    status: 'active',
  }).onConflictDoNothing().returning();

  const bizId = biz?.id;

  // 2. Users
  const seedUsers = [
    { email: 'owner@stato.app', name: 'Sam Owner', role: 'owner' as const, password: 'owner123' },
    { email: 'finance@stato.app', name: 'Finance Admin', role: 'finance_admin' as const, password: 'finance123' },
    { email: 'ops@stato.app', name: 'Ops Manager', role: 'ops_manager' as const, password: 'ops123' },
    { email: 'readonly@stato.app', name: 'Readonly User', role: 'readonly' as const, password: 'readonly123' },
  ];

  for (const u of seedUsers) {
    const passwordHash = await bcryptjs.hash(u.password, 12);
    await db.insert(users).values({
      email: u.email,
      passwordHash,
      name: u.name,
      role: u.role,
      businessId: bizId,
    }).onConflictDoNothing();
  }

  // 3. Sample client
  if (bizId) {
    const [sampleClient] = await db.insert(clients).values({
      businessId: bizId,
      companyName: 'Apex Media Ltd',
      contactName: 'John Smith',
      contactEmail: 'john@apexmedia.co.uk',
      status: 'active',
      onboardingStatus: 'active',
      currency: 'GBP',
      paymentTermsDays: 30,
    }).onConflictDoNothing().returning();

    // 4. Client portal user
    if (sampleClient) {
      const clientHash = await bcryptjs.hash('client123', 12);
      await db.insert(users).values({
        email: 'client@stato.app',
        passwordHash: clientHash,
        name: 'Client User',
        role: 'client',
        businessId: bizId,
        clientId: sampleClient.id,
      }).onConflictDoNothing();
    }
  }

  console.log('Seed complete!');
  console.log('  owner@stato.app / owner123');
  console.log('  finance@stato.app / finance123');
  console.log('  ops@stato.app / ops123');
  console.log('  client@stato.app / client123');
  console.log('  readonly@stato.app / readonly123');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
