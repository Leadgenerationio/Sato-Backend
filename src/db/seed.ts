import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import bcryptjs from 'bcryptjs';
import { businesses, users, clients, notifications } from './schema/index.js';

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

  // 5. Sample notifications
  const sampleNotifications = [
    { type: 'invoice_overdue', title: 'Invoice INV-2026-042 overdue', message: 'TradeFX Ltd invoice of £4,200.00 is 14 days past due.', severity: 'warning', read: false },
    { type: 'credit_alert', title: 'Credit score drop — Apex Leads', message: 'Apex Leads credit score fell from 72 to 54. Risk rating changed to Medium.', severity: 'warning', read: false },
    { type: 'workflow_complete', title: 'Monthly invoicing workflow finished', message: '12 invoices generated for March billing cycle.', severity: 'info', read: false },
    { type: 'payment_received', title: 'Payment received — GreenField Marketing', message: 'GreenField Marketing paid invoice INV-2026-038 (£6,750.00).', severity: 'info', read: false },
    { type: 'lead_delivery', title: 'Lead delivery spike — Solar UK campaign', message: 'Solar UK campaign received 342 leads today, 85% above daily average.', severity: 'info', read: true },
    { type: 'vat_shortfall', title: 'VAT shortfall detected — Q1 2026', message: 'Estimated VAT liability exceeds collected VAT by £1,230.45.', severity: 'warning', read: false },
    { type: 'system_error', title: 'LeadByte sync failed', message: 'Hourly LeadByte sync failed at 09:00 — connection timeout.', severity: 'error', read: false },
    { type: 'agreement_signed', title: 'Agreement sent — Vertex Partners', message: 'Awaiting signature via DocuSign.', severity: 'info', read: true },
  ];

  for (const n of sampleNotifications) {
    await db.insert(notifications).values(n).onConflictDoNothing();
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
