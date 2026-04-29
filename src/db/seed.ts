import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import bcryptjs from 'bcryptjs';
import { businesses, users } from './schema/index.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = postgres(connectionString);
const db = drizzle(client);

// Demo client + sample notifications are OFF by default everywhere. Must be
// opted in explicitly with SEED_DEMO_DATA=true. Production never gets demo
// data unless the operator sets that env var deliberately. Per the no-fake-
// data policy, the recommendation is to never enable this in any tenant a
// real user can sign into.
const SEED_DEMO_DATA = process.env.SEED_DEMO_DATA === 'true';

async function seed() {
  console.log('Seeding...');

  // Stable UUID matches the in-memory seed users' businessId in data/users.ts.
  const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';

  // 1. Business
  await db.insert(businesses).values({
    id: LEADGEN_BUSINESS_ID,
    name: 'leadgeneration.io',
    slug: 'leadgeneration',
    colour: '#171717',
    status: 'active',
  }).onConflictDoNothing();

  const bizId = LEADGEN_BUSINESS_ID;

  // 2. Internal users — passwords come from env in prod, defaults only for local dev.
  const seedUsers = [
    { email: 'owner@stato.app', name: 'Sam Owner', role: 'owner' as const, password: process.env.SEED_OWNER_PASSWORD || 'owner123' },
    { email: 'finance@stato.app', name: 'Finance Admin', role: 'finance_admin' as const, password: process.env.SEED_FINANCE_PASSWORD || 'finance123' },
    { email: 'ops@stato.app', name: 'Ops Manager', role: 'ops_manager' as const, password: process.env.SEED_OPS_PASSWORD || 'ops123' },
    { email: 'readonly@stato.app', name: 'Readonly User', role: 'readonly' as const, password: process.env.SEED_READONLY_PASSWORD || 'readonly123' },
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

  if (SEED_DEMO_DATA && bizId) {
    await seedDemoData(bizId);
  }

  console.log('Seed complete!');
  console.log('  owner@stato.app / <password>');
  console.log('  finance@stato.app / <password>');
  console.log('  ops@stato.app / <password>');
  console.log('  readonly@stato.app / <password>');
  if (SEED_DEMO_DATA) console.log('  + demo data seeded');
  process.exit(0);
}

async function seedDemoData(bizId: string) {
  const { clients, notifications } = await import('./schema/index.js');

  // Stable UUID matches the in-memory `client@stato.app` user's clientId in data/users.ts.
  const DEMO_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
  const [sampleClient] = await db.insert(clients).values({
    id: DEMO_CLIENT_ID,
    businessId: bizId,
    companyName: 'Apex Media Ltd (for demo)',
    contactName: 'John Smith (for demo)',
    contactEmail: 'john@apexmedia.co.uk',
    status: 'active',
    onboardingStatus: 'active',
    currency: 'GBP',
    paymentTermsDays: 30,
  }).onConflictDoNothing().returning();

  if (sampleClient) {
    const clientHash = await bcryptjs.hash(process.env.SEED_DEMO_CLIENT_PASSWORD || 'client123', 12);
    await db.insert(users).values({
      email: 'client@stato.app',
      passwordHash: clientHash,
      name: 'Client User',
      role: 'client',
      businessId: bizId,
      clientId: sampleClient.id,
    }).onConflictDoNothing();
  }

  const sampleNotifications = [
    { type: 'invoice_overdue', title: 'Invoice INV-2026-042 overdue (for demo)', message: 'TradeFX Ltd (for demo) invoice of £4,200.00 is 14 days past due.', severity: 'warning', read: false },
    { type: 'credit_alert', title: 'Credit score drop — Apex Leads (for demo)', message: 'Apex Leads (for demo) credit score fell from 72 to 54. Risk rating changed to Medium.', severity: 'warning', read: false },
    { type: 'workflow_complete', title: 'Monthly invoicing workflow finished (for demo)', message: '12 invoices generated for March billing cycle (for demo).', severity: 'info', read: false },
  ];

  for (const n of sampleNotifications) {
    await db.insert(notifications).values(n).onConflictDoNothing();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
