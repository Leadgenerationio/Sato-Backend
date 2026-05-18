import { db } from '../src/config/database.js';
import { clients } from '../src/db/schema/clients.js';
import { sql } from 'drizzle-orm';

const rows = await db
  .select()
  .from(clients)
  .where(sql`company_name ILIKE '%benson%' OR company_name ILIKE '%goldstein%'`);

if (rows.length === 0) {
  console.log('NO BENSON ROW FOUND');
} else {
  for (const r of rows) {
    console.log({
      id: r.id,
      companyName: r.companyName,
      companyNumber: r.companyNumber,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      contactPhone: r.contactPhone,
      leadbyteClientId: r.leadbyteClientId,
      xeroContactId: r.xeroContactId,
      onboardingStatus: r.onboardingStatus,
      status: r.status,
      agreementSigned: r.agreementSigned,
      clientType: r.clientType,
      createdAt: r.createdAt,
    });
  }
}
process.exit(0);
