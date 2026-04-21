import type { AuthPayload } from '../types/index.js';

// ─── Types ───

export interface Sop {
  id: string;
  title: string;
  content: string;
  category: 'Operations' | 'Finance' | 'Onboarding' | 'Compliance' | 'Campaigns';
  version: string;
  author: string;
  lastUpdated: string;
  status: 'published' | 'draft';
}

// ─── Mock Data ───

const MOCK_SOPS: Sop[] = [
  {
    id: 'sop-1',
    title: 'New Client Onboarding Procedure',
    content: `This SOP covers the end-to-end process for onboarding a new lead generation client at leadgeneration.io.

Before beginning the onboarding process, verify that the client has completed all pre-qualification steps. This includes a signed service agreement, a passed credit check via Endole (minimum score of 50), and confirmation of their target verticals and lead volume requirements.

Once the agreement is signed, set up the client profile in the system. This involves creating a billing profile with their agreed CPL rates, configuring their LeadByte campaign with the correct routing rules, and scheduling a kickoff call within 48 hours of agreement signature.

During the kickoff call, walk the client through the portal dashboard, explain lead delivery schedules, and set expectations around lead quality SLAs. Ensure they have portal login credentials and understand how to view and dispute leads.

Post-onboarding, monitor the first week of lead delivery closely. Check rejection rates daily and flag any issues to the ops team. After the first billing cycle, schedule a check-in call to confirm the client is satisfied with volume and quality.`,
    category: 'Onboarding',
    version: '2.1',
    author: 'Sam Owner',
    lastUpdated: '2026-04-10T09:00:00Z',
    status: 'published',
  },
  {
    id: 'sop-2',
    title: 'Weekly Invoice Batch Review',
    content: `This SOP outlines the process for reviewing and approving the weekly invoice batch before sending to clients.

Every Monday morning, the finance team pulls the auto-generated invoice batch from the billing system. Each invoice is cross-referenced against the LeadByte delivery report for the corresponding period. Verify that lead counts match, CPL rates are correct, and any credit notes from the previous week have been applied.

For any discrepancies, flag the invoice and create a task assigned to the ops team for investigation. Do not send flagged invoices until the discrepancy is resolved. All clean invoices should be approved and queued for sending by 12:00 noon on Monday.

After sending, update the invoice status in the system to "sent" and set the payment due date to 14 days from the invoice date. Monitor for any immediate client queries or disputes within the first 24 hours of sending.`,
    category: 'Finance',
    version: '1.3',
    author: 'Finance Admin',
    lastUpdated: '2026-04-08T14:00:00Z',
    status: 'published',
  },
  {
    id: 'sop-3',
    title: 'Lead Quality Audit Process',
    content: `This SOP defines the standard process for auditing lead quality across active campaigns.

On a weekly basis, the ops team selects a random sample of 50 leads per campaign for quality review. Each lead is checked against the following criteria: valid contact details, correct geographic targeting, matching vertical interest, and no duplicate entries within a 30-day window.

For each lead that fails quality checks, document the specific failure reason and the originating supplier. If a single supplier accounts for more than 10% of failed leads in a given week, escalate immediately to the supplier relationship manager for investigation.

Compile the weekly audit results into a summary report. This report should include pass/fail rates per campaign, per supplier, and per vertical. Share the report with the ops manager by Friday EOD. Any campaigns with a pass rate below 90% should be flagged for immediate review.

Maintain a rolling 12-week quality trend for each supplier. Suppliers consistently below 92% quality should be placed on a performance improvement plan or considered for removal from the supplier panel.`,
    category: 'Operations',
    version: '1.5',
    author: 'Ops Manager',
    lastUpdated: '2026-04-12T10:00:00Z',
    status: 'published',
  },
  {
    id: 'sop-4',
    title: 'Overdue Payment Collection Procedure',
    content: `This SOP describes the escalation process for collecting overdue payments from clients.

When an invoice passes its due date without payment, the system automatically flags it as overdue. On the first business day after the due date, send an automated reminder email to the client's billing contact. This email should reference the invoice number, amount, and original due date.

If no payment is received within 7 days of the first reminder, send a second reminder via email and follow up with a phone call to the client's primary contact. Document the outcome of the call in the client notes. If the client disputes the invoice, create a dispute task and pause collection activity on that invoice.

After 14 days overdue with no response or payment, escalate to the account owner (Sam). At this stage, consider pausing lead delivery to the client until the outstanding balance is resolved. Send a formal notice via email stating that services may be suspended.

For invoices overdue beyond 30 days, initiate the formal debt recovery process. This includes sending a final demand letter and, if necessary, engaging the collections agency. Update the client's credit risk status in the system accordingly.`,
    category: 'Finance',
    version: '2.0',
    author: 'Finance Admin',
    lastUpdated: '2026-04-05T11:00:00Z',
    status: 'published',
  },
  {
    id: 'sop-5',
    title: 'Campaign Launch Checklist',
    content: `This SOP provides the step-by-step checklist for launching a new lead generation campaign in LeadByte.

Before creating the campaign, confirm all prerequisites: signed client agreement, billing profile created, target vertical confirmed, geographic targeting defined, and daily/weekly lead volume caps agreed. All of these should be documented in the client's profile.

In LeadByte, create a new campaign using the standard naming convention: [ClientName]-[Vertical]-[YYYY-MM]. Configure the lead routing rules to deliver leads via the client's preferred method (API, email, or portal). Set the agreed CPL rate and configure any volume caps or scheduling rules.

Run a minimum of 5 test leads through the campaign before going live. Verify that leads are delivered correctly, that the client receives them in the expected format, and that the billing system records the correct charge. Get written confirmation from the client that test leads were received successfully.

Once live, monitor the campaign closely for the first 48 hours. Check delivery rates, rejection rates, and supplier fill rates every 4 hours. If rejection rates exceed 5% in the first 48 hours, pause the campaign and investigate before continuing.`,
    category: 'Campaigns',
    version: '1.8',
    author: 'Ops Manager',
    lastUpdated: '2026-04-11T16:00:00Z',
    status: 'published',
  },
  {
    id: 'sop-6',
    title: 'Monthly Credit Score Review',
    content: `This SOP covers the monthly process for reviewing client credit scores and managing credit risk.

On the first business day of each month, pull the complete list of active clients from the system. For each client, run a credit check through the Endole API. Record the current score and compare it against the previous month's score stored in the system.

Flag any client whose credit score has dropped by more than 10 points since the last review. For flagged clients, check their current payment status — are they up to date, or do they have overdue invoices? This context is critical for the risk assessment.

Prepare a credit risk summary report and present it to Sam by the 3rd business day of the month. The report should categorize clients into three risk tiers: Green (score above 60, no overdue payments), Amber (score 40-60, or overdue payments under 14 days), and Red (score below 40, or payments overdue beyond 14 days).

For any client moving to Red status, recommend immediate action: reduce lead volume caps, require advance payment, or pause delivery until the risk is mitigated. Document all decisions and actions taken in the client notes.`,
    category: 'Compliance',
    version: '1.2',
    author: 'Finance Admin',
    lastUpdated: '2026-04-01T09:00:00Z',
    status: 'published',
  },
  {
    id: 'sop-7',
    title: 'Supplier Performance Review',
    content: `This SOP outlines the quarterly process for reviewing supplier performance and renegotiating terms.

At the end of each quarter, compile performance metrics for all active lead suppliers. Key metrics include: total leads delivered, lead quality pass rate (from weekly audits), average delivery time, and cost per lead (CPL) against contracted rates.

Compare each supplier's performance against their contractual SLAs. Identify any suppliers who have consistently underperformed — specifically, those with quality rates below 92% or delivery shortfalls of more than 10% against committed volumes.

For underperforming suppliers, schedule a review meeting within the first two weeks of the new quarter. Present the performance data and agree on a corrective action plan. If the supplier has been on a performance improvement plan for two consecutive quarters without improvement, initiate the supplier exit process.

For high-performing suppliers, consider renegotiating terms to increase volume commitments in exchange for better CPL rates. Document all renegotiated terms and update the supplier contracts in the system. Ensure the finance team is notified of any rate changes before the next billing cycle.`,
    category: 'Operations',
    version: '1.0',
    author: 'Sam Owner',
    lastUpdated: '2026-03-28T10:00:00Z',
    status: 'published',
  },
  {
    id: 'sop-8',
    title: 'GDPR Data Handling for Lead Records',
    content: `This SOP defines the procedures for handling personal data in lead records in compliance with GDPR regulations.

All lead data collected through our campaigns contains personal information (name, email, phone number, address). This data must be handled in accordance with the UK GDPR and the Data Protection Act 2018. Every team member who handles lead data must complete annual GDPR training.

Lead data must not be retained for longer than 12 months after the last client interaction. Set up automated data purge rules in the system to delete lead records older than 12 months. Before deletion, verify that no active disputes or billing queries reference the affected records.

When a data subject submits a Subject Access Request (SAR) or a deletion request, the request must be acknowledged within 24 hours and fulfilled within 30 calendar days. Use the data export tool to compile all records associated with the data subject and deliver them in a machine-readable format.

In the event of a data breach, immediately notify the account owner and follow the breach response protocol. The ICO must be notified within 72 hours if the breach is likely to result in a risk to individuals' rights. Document all breach incidents and response actions in the compliance log.`,
    category: 'Compliance',
    version: '1.4',
    author: 'Sam Owner',
    lastUpdated: '2026-04-03T15:00:00Z',
    status: 'draft',
  },
];

let nextSopId = 9;

// ─── Service ───

export interface SopFilters {
  category?: string;
  search?: string;
  status?: string;
}

export async function listSops(_requester: AuthPayload, filters?: SopFilters): Promise<Sop[]> {
  let sops = [...MOCK_SOPS];

  if (filters?.category && filters.category !== 'all') {
    sops = sops.filter((s) => s.category.toLowerCase() === filters.category!.toLowerCase());
  }
  if (filters?.status && filters.status !== 'all') {
    sops = sops.filter((s) => s.status === filters.status);
  }
  if (filters?.search) {
    const q = filters.search.toLowerCase();
    sops = sops.filter((s) =>
      s.title.toLowerCase().includes(q) || s.content.toLowerCase().includes(q),
    );
  }

  return sops;
}

export async function getSop(id: string): Promise<Sop | null> {
  return MOCK_SOPS.find((s) => s.id === id) ?? null;
}

export async function createSop(data: Partial<Sop>, _requester: AuthPayload): Promise<Sop> {
  const sop: Sop = {
    id: `sop-${nextSopId++}`,
    title: data.title || '',
    content: data.content || '',
    category: data.category || 'Operations',
    version: '1.0',
    author: _requester.email,
    lastUpdated: new Date().toISOString(),
    status: data.status || 'draft',
  };
  MOCK_SOPS.push(sop);
  return sop;
}

export async function updateSop(id: string, data: Partial<Sop>): Promise<Sop | null> {
  const sop = MOCK_SOPS.find((s) => s.id === id);
  if (!sop) return null;
  const { id: _id, author: _author, ...updatable } = data;
  Object.assign(sop, updatable);
  sop.lastUpdated = new Date().toISOString();
  return sop;
}
