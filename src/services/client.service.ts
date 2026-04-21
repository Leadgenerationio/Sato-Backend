import * as creditCheck from '../integrations/credit-check/index.js';
import type { AuthPayload } from '../types/index.js';

export interface ClientSummary {
  id: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  status: string;
  currency: string;
  creditScore: number | null;
  activeCampaigns: number;
  totalRevenue: number;
  createdAt: string;
}

export interface ClientDetail extends ClientSummary {
  companyNumber: string;
  contactPhone: string;
  address: string;
  paymentTermsDays: number;
  vatRegistered: boolean;
  addVatToInvoices: boolean;
  leadPrice: number;
  billingWorkflow: string;
  onboardingStatus: string;
  agreementSigned: boolean;
  creditLastChecked: string | null;
  creditRiskRating: string | null;
  leadbyteClientId?: string | null;
  endoleCompanyId?: string | null;
  xeroContactId?: string | null;
  notes: string;
}

export interface CreditCheckEntry {
  id: string;
  creditScore: number;
  riskRating: string;
  ccjCount: number;
  ccjTotal: number;
  checkedAt: string;
  scoreChange: number | null;
}

// ─── Mock Data ───

const MOCK_CLIENTS: ClientDetail[] = [
  {
    id: 'c-1', companyName: 'Apex Media Ltd', companyNumber: '12345678', contactName: 'James Wright', contactEmail: 'billing@apexmedia.co.uk', contactPhone: '+44 20 7946 0958',
    address: '10 Fleet Street, London EC4Y 1AU', status: 'active', currency: 'GBP', paymentTermsDays: 30, vatRegistered: true, addVatToInvoices: true,
    leadPrice: 12.50, billingWorkflow: 'weekly_auto', onboardingStatus: 'active', agreementSigned: true,
    creditScore: 82, creditLastChecked: '2026-04-10T09:00:00Z', creditRiskRating: 'low', activeCampaigns: 2, totalRevenue: 45200, notes: 'Key account. Prefers weekly invoicing.', createdAt: '2025-06-15T10:00:00Z',
  },
  {
    id: 'c-2', companyName: 'Brightfield Corp', companyNumber: '23456789', contactName: 'Sarah Chen', contactEmail: 'accounts@brightfield.io', contactPhone: '+44 20 7946 1234',
    address: '25 Canary Wharf, London E14 5AB', status: 'active', currency: 'GBP', paymentTermsDays: 14, vatRegistered: true, addVatToInvoices: true,
    leadPrice: 8.00, billingWorkflow: 'monthly_validated', onboardingStatus: 'active', agreementSigned: true,
    creditScore: 71, creditLastChecked: '2026-04-08T09:00:00Z', creditRiskRating: 'low', activeCampaigns: 1, totalRevenue: 28900, notes: '', createdAt: '2025-08-20T10:00:00Z',
  },
  {
    id: 'c-3', companyName: 'Clearwater Digital', companyNumber: '34567890', contactName: 'Mike Thompson', contactEmail: 'finance@clearwater.com', contactPhone: '+44 161 496 0800',
    address: '5 Spinningfields, Manchester M3 3EB', status: 'active', currency: 'GBP', paymentTermsDays: 30, vatRegistered: false, addVatToInvoices: false,
    leadPrice: 22.00, billingWorkflow: 'weekly_auto', onboardingStatus: 'active', agreementSigned: true,
    creditScore: 55, creditLastChecked: '2026-04-05T09:00:00Z', creditRiskRating: 'moderate', activeCampaigns: 2, totalRevenue: 67800, notes: 'Credit score dropped recently. Monitor closely.', createdAt: '2025-09-10T10:00:00Z',
  },
  {
    id: 'c-4', companyName: 'Delta Solutions', companyNumber: '45678901', contactName: 'Laura Davies', contactEmail: 'pay@deltasol.co.uk', contactPhone: '+44 113 496 1500',
    address: '12 Wellington Place, Leeds LS1 4AP', status: 'paused', currency: 'GBP', paymentTermsDays: 60, vatRegistered: true, addVatToInvoices: true,
    leadPrice: 15.00, billingWorkflow: 'custom', onboardingStatus: 'active', agreementSigned: true,
    creditScore: 42, creditLastChecked: '2026-04-01T09:00:00Z', creditRiskRating: 'high', activeCampaigns: 0, totalRevenue: 12400, notes: 'Paused due to payment issues. Has 2 overdue invoices.', createdAt: '2025-07-01T10:00:00Z',
  },
  {
    id: 'c-5', companyName: 'Echo Marketing', companyNumber: '56789012', contactName: 'Tom Harris', contactEmail: 'admin@echomarketing.com', contactPhone: '+44 117 496 2000',
    address: '8 Queen Square, Bristol BS1 4NT', status: 'active', currency: 'EUR', paymentTermsDays: 30, vatRegistered: true, addVatToInvoices: true,
    leadPrice: 6.50, billingWorkflow: 'monthly_validated', onboardingStatus: 'active', agreementSigned: true,
    creditScore: 91, creditLastChecked: '2026-04-12T09:00:00Z', creditRiskRating: 'very_low', activeCampaigns: 1, totalRevenue: 19500, notes: 'Excellent credit. EU client — invoices in EUR.', createdAt: '2025-11-05T10:00:00Z',
  },
  {
    id: 'c-6', companyName: 'Falcon Industries', companyNumber: '67890123', contactName: 'Rachel Green', contactEmail: 'rachel@falconind.co.uk', contactPhone: '+44 20 7946 3000',
    address: '30 St Mary Axe, London EC3A 8BF', status: 'prospect', currency: 'GBP', paymentTermsDays: 30, vatRegistered: true, addVatToInvoices: true,
    leadPrice: 18.00, billingWorkflow: 'weekly_auto', onboardingStatus: 'pending', agreementSigned: false,
    creditScore: null, creditLastChecked: null, creditRiskRating: null, activeCampaigns: 0, totalRevenue: 0, notes: 'New prospect. Interested in solar leads.', createdAt: '2026-04-01T10:00:00Z',
  },
  {
    id: 'c-7', companyName: 'GreenTech Solar', companyNumber: '78901234', contactName: 'David Wilson', contactEmail: 'david@greentech.co.uk', contactPhone: '+44 121 496 4000',
    address: '50 Colmore Row, Birmingham B3 2AA', status: 'onboarding', currency: 'GBP', paymentTermsDays: 14, vatRegistered: false, addVatToInvoices: false,
    leadPrice: 20.00, billingWorkflow: 'weekly_auto', onboardingStatus: 'documents_received', agreementSigned: false,
    creditScore: 67, creditLastChecked: '2026-04-14T09:00:00Z', creditRiskRating: 'low', activeCampaigns: 0, totalRevenue: 0, notes: 'Onboarding in progress. Waiting for agreement signature.', createdAt: '2026-03-20T10:00:00Z',
  },
  {
    id: 'c-8', companyName: 'Heritage Finance', companyNumber: '89012345', contactName: 'Emma Brown', contactEmail: 'emma@heritagefin.com', contactPhone: '+44 131 496 5000',
    address: '1 Charlotte Square, Edinburgh EH2 4DR', status: 'churned', currency: 'GBP', paymentTermsDays: 30, vatRegistered: true, addVatToInvoices: true,
    leadPrice: 35.00, billingWorkflow: 'monthly_validated', onboardingStatus: 'active', agreementSigned: true,
    creditScore: 38, creditLastChecked: '2026-03-01T09:00:00Z', creditRiskRating: 'very_high', activeCampaigns: 0, totalRevenue: 8200, notes: 'Churned. Multiple unpaid invoices.', createdAt: '2025-05-10T10:00:00Z',
  },
];

function generateCreditHistory(clientId: string): CreditCheckEntry[] {
  const client = MOCK_CLIENTS.find((c) => c.id === clientId);
  if (!client || !client.creditScore) return [];

  const history: CreditCheckEntry[] = [];
  let score = client.creditScore;

  for (let i = 0; i < 6; i++) {
    const date = new Date();
    date.setMonth(date.getMonth() - i);
    const prevScore = i < 5 ? score + Math.floor(Math.random() * 10) - 4 : null;
    const change = prevScore !== null ? score - prevScore : null;

    let riskRating: string;
    if (score >= 80) riskRating = 'very_low';
    else if (score >= 65) riskRating = 'low';
    else if (score >= 50) riskRating = 'moderate';
    else if (score >= 35) riskRating = 'high';
    else riskRating = 'very_high';

    history.push({
      id: `cc-${clientId}-${i}`,
      creditScore: score,
      riskRating,
      ccjCount: score < 50 ? Math.floor(Math.random() * 3) : 0,
      ccjTotal: score < 50 ? Math.floor(Math.random() * 15000) : 0,
      checkedAt: date.toISOString(),
      scoreChange: change,
    });

    score = prevScore ?? score;
  }

  return history;
}

let nextId = 9;

// ─── Service ───

export async function listClients(_requester: AuthPayload): Promise<ClientSummary[]> {
  return MOCK_CLIENTS.map(({ companyNumber, contactPhone, address, paymentTermsDays, vatRegistered, addVatToInvoices, leadPrice, billingWorkflow, onboardingStatus, agreementSigned, creditLastChecked, creditRiskRating, notes, ...summary }) => summary);
}

export async function getClient(id: string, _requester: AuthPayload): Promise<ClientDetail | null> {
  return MOCK_CLIENTS.find((c) => c.id === id) ?? null;
}

export async function createClient(data: Partial<ClientDetail>, _requester: AuthPayload): Promise<ClientDetail> {
  const client: ClientDetail = {
    id: `c-${nextId++}`,
    companyName: data.companyName || '',
    companyNumber: data.companyNumber || '',
    contactName: data.contactName || '',
    contactEmail: data.contactEmail || '',
    contactPhone: data.contactPhone || '',
    address: data.address || '',
    status: 'prospect',
    currency: data.currency || 'GBP',
    paymentTermsDays: data.paymentTermsDays || 30,
    vatRegistered: data.vatRegistered || false,
    addVatToInvoices: data.addVatToInvoices || false,
    leadPrice: data.leadPrice || 0,
    billingWorkflow: data.billingWorkflow || 'weekly_auto',
    onboardingStatus: 'pending',
    agreementSigned: false,
    creditScore: null,
    creditLastChecked: null,
    creditRiskRating: null,
    leadbyteClientId: data.leadbyteClientId || null,
    endoleCompanyId: data.endoleCompanyId || null,
    xeroContactId: data.xeroContactId || null,
    activeCampaigns: 0,
    totalRevenue: 0,
    notes: data.notes || '',
    createdAt: new Date().toISOString(),
  };
  MOCK_CLIENTS.push(client);
  return client;
}

export async function updateClient(id: string, data: Partial<ClientDetail>, _requester: AuthPayload): Promise<ClientDetail | null> {
  const client = MOCK_CLIENTS.find((c) => c.id === id);
  if (!client) return null;
  Object.assign(client, data);
  return client;
}

export async function getCreditHistory(clientId: string, _requester: AuthPayload): Promise<CreditCheckEntry[]> {
  return generateCreditHistory(clientId);
}

export async function runCreditCheck(clientId: string, _requester: AuthPayload): Promise<CreditCheckEntry | null> {
  const client = MOCK_CLIENTS.find((c) => c.id === clientId);
  if (!client) return null;

  const report = await creditCheck.runCreditCheck(client.companyNumber, client.companyName);

  const prevScore = client.creditScore;
  client.creditScore = report.creditScore;
  client.creditRiskRating = report.riskRating;
  client.creditLastChecked = report.checkedAt;

  return {
    id: `cc-${clientId}-new`,
    creditScore: report.creditScore,
    riskRating: report.riskRating,
    ccjCount: report.ccjCount,
    ccjTotal: report.ccjTotal,
    checkedAt: report.checkedAt,
    scoreChange: prevScore ? report.creditScore - prevScore : null,
  };
}

export async function getCreditAlerts(_requester: AuthPayload): Promise<{ clientId: string; clientName: string; scoreChange: number; currentScore: number }[]> {
  // Mock: return clients with significant recent score drops
  return MOCK_CLIENTS
    .filter((c) => c.creditScore !== null && c.creditScore < 55)
    .map((c) => ({
      clientId: c.id,
      clientName: c.companyName,
      scoreChange: -Math.floor(Math.random() * 15) - 5,
      currentScore: c.creditScore!,
    }));
}
