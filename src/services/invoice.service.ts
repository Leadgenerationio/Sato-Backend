import type { AuthPayload } from '../types/index.js';

export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  status: string;
  currency: string;
  subtotal: number;
  vatAmount: number;
  total: number;
  dueDate: string;
  paidDate: string | null;
  daysOverdue: number;
  createdAt: string;
}

export interface InvoiceDetail extends InvoiceSummary {
  lineItems: LineItem[];
  chaseCount: number;
  lastChasedAt: string | null;
  clientEmail: string;
  vatRegistered: boolean;
}

// ─── Mock Data ───

const MOCK_CLIENTS = [
  { id: 'c-1', name: 'Apex Media Ltd', email: 'billing@apexmedia.co.uk', vatRegistered: true, currency: 'GBP' },
  { id: 'c-2', name: 'Brightfield Corp', email: 'accounts@brightfield.io', vatRegistered: true, currency: 'GBP' },
  { id: 'c-3', name: 'Clearwater Digital', email: 'finance@clearwater.com', vatRegistered: false, currency: 'GBP' },
  { id: 'c-4', name: 'Delta Solutions', email: 'pay@deltasol.co.uk', vatRegistered: true, currency: 'GBP' },
  { id: 'c-5', name: 'Echo Marketing', email: 'admin@echomarketing.com', vatRegistered: true, currency: 'EUR' },
];

function generateMockInvoices(): InvoiceDetail[] {
  const statuses = ['draft', 'sent', 'authorised', 'paid', 'overdue'];
  const invoices: InvoiceDetail[] = [];

  for (let i = 0; i < 25; i++) {
    const client = MOCK_CLIENTS[i % MOCK_CLIENTS.length];
    const status = statuses[i % statuses.length];
    const lineCount = Math.floor(Math.random() * 3) + 1;
    const lines: LineItem[] = [];

    for (let j = 0; j < lineCount; j++) {
      const qty = Math.floor(Math.random() * 100) + 10;
      const price = [6.50, 8.00, 12.50, 15.00, 18.00, 22.00, 35.00][Math.floor(Math.random() * 7)];
      lines.push({
        description: ['Solar Panel Leads', 'Insurance Quotes', 'Mortgage Leads', 'Debt Management Leads', 'Boiler Installation Leads'][j % 5],
        quantity: qty,
        unitPrice: price,
        amount: Math.round(qty * price * 100) / 100,
      });
    }

    const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
    const vatAmount = client.vatRegistered ? Math.round(subtotal * 0.2 * 100) / 100 : 0;
    const total = Math.round((subtotal + vatAmount) * 100) / 100;

    const createdDate = new Date();
    createdDate.setDate(createdDate.getDate() - (i * 3 + Math.floor(Math.random() * 5)));
    const dueDate = new Date(createdDate);
    dueDate.setDate(dueDate.getDate() + 30);

    const isOverdue = status === 'overdue';
    const isPaid = status === 'paid';
    const daysOverdue = isOverdue ? Math.floor(Math.random() * 30) + 1 : 0;

    invoices.push({
      id: `inv-${1050 - i}`,
      invoiceNumber: `INV-${1050 - i}`,
      clientId: client.id,
      clientName: client.name,
      clientEmail: client.email,
      status,
      currency: client.currency,
      subtotal: Math.round(subtotal * 100) / 100,
      vatAmount,
      total,
      dueDate: dueDate.toISOString(),
      paidDate: isPaid ? new Date(dueDate.getTime() - Math.random() * 10 * 86400000).toISOString() : null,
      daysOverdue,
      lineItems: lines,
      chaseCount: isOverdue ? Math.floor(Math.random() * 3) + 1 : 0,
      lastChasedAt: isOverdue ? new Date(Date.now() - Math.random() * 7 * 86400000).toISOString() : null,
      vatRegistered: client.vatRegistered,
      createdAt: createdDate.toISOString(),
    });
  }

  return invoices;
}

let mockInvoices: InvoiceDetail[] | null = null;

function getInvoices() {
  if (!mockInvoices) mockInvoices = generateMockInvoices();
  return mockInvoices;
}

export async function listInvoices(_requester: AuthPayload): Promise<InvoiceSummary[]> {
  return getInvoices().map(({ lineItems, chaseCount, lastChasedAt, clientEmail, vatRegistered, ...summary }) => summary);
}

export async function getInvoice(id: string, _requester: AuthPayload): Promise<InvoiceDetail | null> {
  return getInvoices().find((inv) => inv.id === id) ?? null;
}

export async function getOverdueInvoices(_requester: AuthPayload): Promise<InvoiceSummary[]> {
  return getInvoices()
    .filter((inv) => inv.status === 'overdue')
    .map(({ lineItems, chaseCount, lastChasedAt, clientEmail, vatRegistered, ...summary }) => summary);
}

export async function createInvoice(
  data: { clientId: string; currency: string; lineItems: LineItem[]; addVat: boolean },
  _requester: AuthPayload,
): Promise<InvoiceDetail> {
  const client = MOCK_CLIENTS.find((c) => c.id === data.clientId);
  const subtotal = data.lineItems.reduce((sum, l) => sum + l.amount, 0);
  const vatAmount = data.addVat ? Math.round(subtotal * 0.2 * 100) / 100 : 0;
  const total = Math.round((subtotal + vatAmount) * 100) / 100;
  const invoices = getInvoices();
  const nextNum = 1051 + invoices.length;

  const invoice: InvoiceDetail = {
    id: `inv-${nextNum}`,
    invoiceNumber: `INV-${nextNum}`,
    clientId: data.clientId,
    clientName: client?.name ?? 'Unknown',
    clientEmail: client?.email ?? '',
    status: 'draft',
    currency: data.currency,
    subtotal: Math.round(subtotal * 100) / 100,
    vatAmount,
    total,
    dueDate: new Date(Date.now() + 30 * 86400000).toISOString(),
    paidDate: null,
    daysOverdue: 0,
    lineItems: data.lineItems,
    chaseCount: 0,
    lastChasedAt: null,
    vatRegistered: data.addVat,
    createdAt: new Date().toISOString(),
  };

  invoices.unshift(invoice);
  return invoice;
}

export function getClients() {
  return MOCK_CLIENTS;
}
