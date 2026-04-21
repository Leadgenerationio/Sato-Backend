import type { AuthPayload } from '../types/index.js';

// ─── Mock portal data scoped to client ───

export interface PortalDashboard {
  companyName: string;
  activeCampaigns: number;
  totalLeadsThisMonth: number;
  totalLeadsAllTime: number;
  pendingInvoices: number;
  overdueInvoices: number;
  totalOutstanding: number;
  agreementSigned: boolean;
  recentLeads: { date: string; leads: number }[];
}

export interface PortalCampaign {
  id: string;
  name: string;
  vertical: string;
  status: string;
  leadsThisWeek: number;
  leadsThisMonth: number;
  totalLeads: number;
  startDate: string;
}

export interface PortalLeadDay {
  date: string;
  campaignName: string;
  leadCount: number;
  validLeads: number;
  invalidLeads: number;
}

export interface PortalInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  total: number;
  currency: string;
  dueDate: string;
  paidDate: string | null;
  daysOverdue: number;
}

export interface PortalCompliance {
  campaignName: string;
  creatives: { id: string; name: string; type: string; uploadedAt: string }[];
  landingPages: { id: string; url: string; screenshotUrl: string | null; lastChecked: string }[];
}

export interface PortalAgreement {
  id: string;
  status: 'pending' | 'sent' | 'signed';
  signedAt: string | null;
  documentUrl: string | null;
  clientName: string;
  terms: string;
}

// Row-level scoping: all data filtered by requester's clientId
const CLIENT_ID = 'c-4'; // Maps to Delta Solutions (the demo client user)

export async function getDashboard(requester: AuthPayload): Promise<PortalDashboard> {
  const recentLeads = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    recentLeads.push({ date: d.toISOString().split('T')[0], leads: Math.floor(Math.random() * 25) + 5 });
  }

  return {
    companyName: 'Delta Solutions',
    activeCampaigns: 1,
    totalLeadsThisMonth: 694,
    totalLeadsAllTime: 4820,
    pendingInvoices: 1,
    overdueInvoices: 1,
    totalOutstanding: 1745.00,
    agreementSigned: true,
    recentLeads,
  };
}

export async function getCampaigns(requester: AuthPayload): Promise<PortalCampaign[]> {
  return [
    { id: 'lb-4', name: 'Debt Management Leads', vertical: 'Finance', status: 'paused', leadsThisWeek: 84, leadsThisMonth: 694, totalLeads: 4820, startDate: '2025-08-20' },
  ];
}

export async function getLeads(requester: AuthPayload): Promise<PortalLeadDay[]> {
  const leads: PortalLeadDay[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const total = Math.floor(Math.random() * 30) + 8;
    const valid = Math.floor(total * (0.78 + Math.random() * 0.15));
    leads.push({
      date: d.toISOString().split('T')[0],
      campaignName: 'Debt Management Leads',
      leadCount: total,
      validLeads: valid,
      invalidLeads: total - valid,
    });
  }
  return leads;
}

export async function getInvoices(requester: AuthPayload): Promise<PortalInvoice[]> {
  return [
    { id: 'inv-p1', invoiceNumber: 'INV-1047', status: 'paid', total: 5794.80, currency: 'GBP', dueDate: '2026-04-05T00:00:00Z', paidDate: '2026-04-03T00:00:00Z', daysOverdue: 0 },
    { id: 'inv-p2', invoiceNumber: 'INV-1039', status: 'overdue', total: 950.00, currency: 'GBP', dueDate: '2026-03-28T00:00:00Z', paidDate: null, daysOverdue: 19 },
    { id: 'inv-p3', invoiceNumber: 'INV-1032', status: 'paid', total: 3200.00, currency: 'GBP', dueDate: '2026-03-15T00:00:00Z', paidDate: '2026-03-14T00:00:00Z', daysOverdue: 0 },
    { id: 'inv-p4', invoiceNumber: 'INV-1025', status: 'paid', total: 4100.00, currency: 'GBP', dueDate: '2026-02-28T00:00:00Z', paidDate: '2026-02-25T00:00:00Z', daysOverdue: 0 },
    { id: 'inv-p5', invoiceNumber: 'INV-1052', status: 'sent', total: 795.00, currency: 'GBP', dueDate: '2026-05-10T00:00:00Z', paidDate: null, daysOverdue: 0 },
  ];
}

export async function getCompliance(requester: AuthPayload): Promise<PortalCompliance[]> {
  return [
    {
      campaignName: 'Debt Management Leads',
      creatives: [
        { id: 'cr-1', name: 'Facebook Ad - Debt Help Banner', type: 'image', uploadedAt: '2025-11-10T10:00:00Z' },
        { id: 'cr-2', name: 'Google Ad - Debt Management Text', type: 'text', uploadedAt: '2025-11-15T10:00:00Z' },
        { id: 'cr-3', name: 'Landing Page Video - Testimonial', type: 'video', uploadedAt: '2026-01-20T10:00:00Z' },
      ],
      landingPages: [
        { id: 'lp-1', url: 'https://debthelp.deltasol.co.uk/free-assessment', screenshotUrl: null, lastChecked: '2026-04-10T09:00:00Z' },
        { id: 'lp-2', url: 'https://debthelp.deltasol.co.uk/debt-management-plan', screenshotUrl: null, lastChecked: '2026-04-10T09:00:00Z' },
      ],
    },
  ];
}

export async function getAgreement(requester: AuthPayload): Promise<PortalAgreement> {
  return {
    id: 'agr-1',
    status: 'signed',
    signedAt: '2025-08-15T14:30:00Z',
    documentUrl: null,
    clientName: 'Delta Solutions',
    terms: 'Lead Generation Service Agreement between leadgeneration.io and Delta Solutions. Effective from 20 August 2025. Lead price: £15.00 per valid lead. Payment terms: 60 days. Billing workflow: Custom. Auto-renewal annually unless cancelled with 30 days notice.',
  };
}
