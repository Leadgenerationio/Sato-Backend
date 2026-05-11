import { logger } from '../../utils/logger.js';

/**
 * Xero Custom Connection client (client_credentials grant, server-to-server).
 *
 * Auth flow:
 *   1. POST https://identity.xero.com/connect/token
 *      Basic auth (client_id:client_secret) + `grant_type=client_credentials`
 *      Returns a 30-minute bearer token. No refresh token (just re-auth when expired).
 *   2. GET https://api.xero.com/connections (Bearer) → fetches the bound tenant.
 *      Custom Connections are tied to exactly one tenant at app-config time.
 *   3. Downstream Xero API calls: `Authorization: Bearer <token>` + `xero-tenant-id: <tenantId>`.
 *
 * Docs: https://developer.xero.com/documentation/guides/oauth2/custom-connections
 */

const IDENTITY_HOST = 'https://identity.xero.com';
const API_HOST = 'https://api.xero.com';

const SCOPES = 'accounting.transactions accounting.contacts accounting.reports.read accounting.settings.read';

interface XeroCache {
  accessToken: string;
  expiresAt: number;
  tenantId: string;
  tenantName: string;
}

let cache: XeroCache | null = null;

export const __testing = {
  resetCache() {
    cache = null;
  },
};

function clientId(): string {
  return process.env.XERO_CLIENT_ID || '';
}

function clientSecret(): string {
  return process.env.XERO_CLIENT_SECRET || '';
}

export function isXeroConfigured(): boolean {
  return !!(clientId() && clientSecret());
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

interface ConnectionInfo {
  id: string;
  tenantId: string;
  tenantType?: string;
  tenantName?: string;
}

async function exchangeCredentials(): Promise<{ accessToken: string; expiresAt: number }> {
  const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
  const res = await fetch(`${IDENTITY_HOST}/connect/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: SCOPES,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'Xero token exchange failed');
    throw new Error(`Xero auth failed: ${res.status}`);
  }

  const data = (await res.json()) as TokenResponse;
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function fetchBoundTenant(accessToken: string): Promise<{ tenantId: string; tenantName: string }> {
  const res = await fetch(`${API_HOST}/connections`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'Xero /connections failed');
    throw new Error(`Xero /connections failed: ${res.status}`);
  }
  const connections = (await res.json()) as ConnectionInfo[];
  const first = connections[0];
  if (!first) {
    throw new Error('No Xero tenant bound to this Custom Connection app. Configure in developer.xero.com.');
  }
  return {
    tenantId: first.tenantId,
    tenantName: first.tenantName ?? 'Unknown',
  };
}

/**
 * Get a valid access token + tenant ID. Authenticates on first call and
 * re-authenticates when the cached token is within 60s of expiry.
 */
export async function getValidToken(): Promise<{ accessToken: string; tenantId: string }> {
  if (!isXeroConfigured()) {
    throw new Error('Xero credentials not configured');
  }

  if (cache && cache.expiresAt > Date.now() + 60_000) {
    return { accessToken: cache.accessToken, tenantId: cache.tenantId };
  }

  const { accessToken, expiresAt } = await exchangeCredentials();
  // Re-use cached tenant name if we have it; otherwise fetch it.
  const tenant = cache?.tenantName
    ? { tenantId: cache.tenantId, tenantName: cache.tenantName }
    : await fetchBoundTenant(accessToken);

  cache = { accessToken, expiresAt, tenantId: tenant.tenantId, tenantName: tenant.tenantName };
  logger.info({ tenantName: tenant.tenantName, tenantId: tenant.tenantId }, 'Xero authenticated (Custom Connection)');
  return { accessToken, tenantId: cache.tenantId };
}

export interface XeroStatus {
  configured: boolean;
  connected: boolean;
  tenantId?: string;
  tenantName?: string;
  expiresAt?: Date;
}

/**
 * Non-throwing status — reports whether the app is configured and whether we
 * have a live token. Used by the Settings page.
 */
export async function getStatus(): Promise<XeroStatus> {
  if (!isXeroConfigured()) {
    return { configured: false, connected: false };
  }
  if (cache && cache.expiresAt > Date.now()) {
    return {
      configured: true,
      connected: true,
      tenantId: cache.tenantId,
      tenantName: cache.tenantName,
      expiresAt: new Date(cache.expiresAt),
    };
  }
  return { configured: true, connected: false };
}

/**
 * Clear the in-memory token + tenant cache. Next `getValidToken()` call
 * will re-authenticate from scratch. No Xero-side revoke call needed —
 * Custom Connection tokens can't be individually revoked; they expire on
 * their own. To actually "disconnect" an app, Sam removes it in the Xero
 * developer portal.
 */
export function disconnect(): void {
  cache = null;
  logger.info('Xero cache cleared');
}

export interface CreateContactInput {
  /** Required by Xero. Falls back to companyName if not given. */
  name: string;
  /** From client.contactName — split on first space for First/Last. */
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
}

export interface XeroContact {
  contactId: string;
  name: string;
}

interface XeroContactsResponse {
  Contacts: Array<{ ContactID: string; Name: string }>;
}

/**
 * Create or upsert a Xero Contact for a Sato client. Uses Xero's Contacts API
 * (POST /api.xro/2.0/Contacts). Triggered automatically when an agreement is
 * signed so that the client is ready for invoicing without manual data entry.
 *
 * Required scope: accounting.contacts (already in SCOPES).
 */
export async function createContact(input: CreateContactInput): Promise<XeroContact> {
  const { accessToken, tenantId } = await getValidToken();

  // Split a single contactName into FirstName / LastName for Xero.
  let firstName: string | undefined;
  let lastName: string | undefined;
  if (input.contactName) {
    const trimmed = input.contactName.trim();
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx >= 0) {
      firstName = trimmed.slice(0, spaceIdx);
      lastName = trimmed.slice(spaceIdx + 1);
    } else {
      firstName = trimmed;
    }
  }

  const body: Record<string, unknown> = { Name: input.name };
  if (firstName) body.FirstName = firstName;
  if (lastName) body.LastName = lastName;
  if (input.email) body.EmailAddress = input.email;
  if (input.phone) {
    body.Phones = [{ PhoneType: 'DEFAULT', PhoneNumber: input.phone }];
  }
  if (input.address) {
    body.Addresses = [{ AddressType: 'STREET', AddressLine1: input.address }];
  }

  const res = await fetch(`${API_HOST}/api.xro/2.0/Contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    logger.error({ status: res.status, body: errBody, name: input.name }, 'Xero /Contacts POST failed');
    throw new Error(`Xero createContact failed: ${res.status}`);
  }

  const data = (await res.json()) as XeroContactsResponse;
  const created = data.Contacts?.[0];
  if (!created) {
    throw new Error('Xero createContact returned no contact');
  }
  return { contactId: created.ContactID, name: created.Name };
}

export interface XeroBankAccount {
  accountId: string;
  name: string;
  code: string | null;
  currency: string;
  balance: string; // decimal-on-the-wire
}

interface XeroAccountsResponse {
  Accounts: Array<{
    AccountID: string;
    Name: string;
    Code?: string;
    CurrencyCode?: string;
    Type: string;
    Status: string;
    // Xero exposes the bank account's reported balance directly on /Accounts
    // for BANK-type rows. This is the figure Sam expects to see (matches his
    // Xero dashboard "Bank Balance" widget) — it reflects bank-feed / last
    // reconciled state rather than the ledger view that BankSummary returns.
    // See `getBankBalances` for the precedence: Account.Balance first, then
    // BankSummary closing as a fallback for accounts without bank feeds.
    Balance?: number;
  }>;
}

interface XeroBankSummaryRow {
  RowType: 'Header' | 'Section' | 'Row' | 'SummaryRow';
  Title?: string;
  Cells?: Array<{ Value: string; Attributes?: Array<{ Value: string; Id: string }> }>;
  Rows?: XeroBankSummaryRow[];
}

interface XeroBankSummaryResponse {
  Reports: Array<{
    ReportName: string;
    Rows: XeroBankSummaryRow[];
  }>;
}

/**
 * Fetch live bank-account balances from Xero.
 *
 * Sam Loom #1: previously this returned the Xero ledger closing balance
 * (BankSummary's "Closing Balance" column), which includes approved-but-
 * unreconciled transactions and so didn't match the £52,446 Sam sees on
 * his Xero dashboard for Clinical Marketing Solutions (vs the £113,515
 * we were showing). The fix is to prefer `Account.Balance` from the
 * `/Accounts` endpoint — Xero populates this with the bank's reported
 * balance for BANK-type accounts, matching Sam's expected number.
 *
 * Precedence per account:
 *   1. `Account.Balance` (statement balance — what Sam wants)
 *   2. BankSummary closing as a fallback for old accounts without it
 *
 * Combines:
 *   /Accounts?where=Type=="BANK"      → list of bank accounts + Balance
 *   /Reports/BankSummary               → fallback closing balance
 *
 * Required Xero scopes: accounting.settings.read + accounting.reports.read.
 * If Sam's Custom Connection wasn't configured with those scopes, this throws
 * a 403 — caller should fall back gracefully.
 */
export async function getBankBalances(): Promise<XeroBankAccount[]> {
  const { accessToken, tenantId } = await getValidToken();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'xero-tenant-id': tenantId,
    Accept: 'application/json',
  };

  const accountsRes = await fetch(
    `${API_HOST}/api.xro/2.0/Accounts?where=${encodeURIComponent('Type=="BANK"&&Status=="ACTIVE"')}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  if (!accountsRes.ok) {
    const body = await accountsRes.text();
    logger.error({ status: accountsRes.status, body }, 'Xero /Accounts failed');
    throw new Error(`Xero accounts fetch failed: ${accountsRes.status}`);
  }
  const accountsData = (await accountsRes.json()) as XeroAccountsResponse;
  const bankAccounts = accountsData.Accounts ?? [];

  // Bank summary as of today
  const today = new Date().toISOString().slice(0, 10);
  const summaryRes = await fetch(
    `${API_HOST}/api.xro/2.0/Reports/BankSummary?date=${today}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  const balanceByAccountId = new Map<string, string>();
  if (summaryRes.ok) {
    const summaryData = (await summaryRes.json()) as XeroBankSummaryResponse;
    const rows = summaryData.Reports?.[0]?.Rows ?? [];
    // BankSummary structure: a Section row whose nested Rows contain one Row per bank account.
    // Each Row has Cells: [name, opening, money in, money out, closing].
    // The first cell carries the AccountID via Attributes.
    for (const section of rows) {
      if (section.RowType === 'Section' && section.Rows) {
        for (const row of section.Rows) {
          if (row.RowType !== 'Row' || !row.Cells) continue;
          const idAttr = row.Cells[0]?.Attributes?.find((a) => a.Id === 'accountID');
          const closing = row.Cells[row.Cells.length - 1]?.Value ?? '0';
          if (idAttr?.Value) balanceByAccountId.set(idAttr.Value, closing);
        }
      }
    }
  } else {
    // BankSummary failed (e.g. missing reports.read scope) — return accounts with 0 balance
    // rather than blowing up. Caller can show "balance unavailable" UI.
    const body = await summaryRes.text();
    logger.warn({ status: summaryRes.status, body }, 'Xero /Reports/BankSummary failed — returning zero balances');
  }

  return bankAccounts.map((a) => {
    // Prefer Account.Balance (statement-style figure that matches the Xero
    // dashboard widget). Fall back to BankSummary closing if Xero didn't
    // populate Balance — happens occasionally for archived or zero-activity
    // accounts.
    const statementBalance = typeof a.Balance === 'number'
      ? a.Balance.toFixed(2)
      : balanceByAccountId.get(a.AccountID) ?? '0';
    return {
      accountId: a.AccountID,
      name: a.Name,
      code: a.Code ?? null,
      currency: a.CurrencyCode ?? 'GBP',
      balance: statementBalance,
    };
  });
}

export interface XeroVatLiability {
  fromDate: string;   // ISO date
  toDate: string;     // ISO date
  owed: string;       // decimal-on-the-wire, GBP
  collectedOnSales: string;
  paidOnPurchases: string;
}

interface XeroReportCell {
  Value: string;
  Attributes?: Array<{ Value: string; Id: string }>;
}

interface XeroReportRow {
  RowType: string;
  Title?: string;
  Cells?: XeroReportCell[];
  Rows?: XeroReportRow[];
}

interface XeroTaxSummaryResponse {
  Reports: Array<{
    ReportName: string;
    Rows: XeroReportRow[];
  }>;
}

/**
 * Sum the "Tax Amount" column for either Sales or Purchases section in a
 * Xero TaxSummary report.
 *
 * Report structure:
 *   Section "Sales" (or "Purchases")
 *     Row     "Standard Rate (20%)" | net | tax
 *     Row     "Zero Rated"          | net | tax
 *     SummaryRow "Total Sales VAT"  | _   | tax-total
 */
function sumTaxSection(rows: XeroReportRow[], sectionTitle: string): number {
  const section = rows.find((r) => r.RowType === 'Section' && r.Title === sectionTitle);
  if (!section?.Rows) return 0;
  const summary = section.Rows.find((r) => r.RowType === 'SummaryRow');
  // Tax column is the LAST cell (Net | Tax). Some Xero variants put it 3rd.
  const cells = summary?.Cells ?? [];
  const taxCell = cells[cells.length - 1];
  const n = parseFloat(taxCell?.Value ?? '0');
  return Number.isFinite(n) ? n : 0;
}

export interface XeroBankTransaction {
  xeroBankTransactionId: string;
  xeroAccountId: string | null;
  date: string;          // ISO date YYYY-MM-DD
  amount: string;        // signed decimal-on-the-wire (negative = money out)
  currency: string;
  description: string | null;
  vendorName: string | null;
}

interface XeroBankTransactionsResponse {
  BankTransactions: Array<{
    BankTransactionID: string;
    Type: string;        // RECEIVE / SPEND / RECEIVE-OVERPAYMENT / etc
    Date?: string;       // /Date(unix)/  format
    Total?: number;      // gross total
    SubTotal?: number;
    CurrencyCode?: string;
    Reference?: string;
    BankAccount?: { AccountID: string; Name?: string };
    Contact?: { Name?: string };
    LineItems?: Array<{ Description?: string }>;
  }>;
}

function parseXeroDate(s?: string): string {
  if (!s) return new Date().toISOString().slice(0, 10);
  // /Date(1714003200000+0000)/ → extract ms
  const m = /\/Date\((-?\d+)/.exec(s);
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  // Fallback: assume already ISO
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : s.slice(0, 10);
}

/**
 * Pull bank transactions from Xero for a date range.
 *
 * Xero `Type=SPEND` (money out) is what we care about for cost categorisation;
 * `Type=RECEIVE` is income. We pull both so frontend can filter; amounts are
 * SIGNED — SPEND becomes negative.
 *
 * Pages of 100 by default, returns at most `maxPages * 100`.
 *
 * Required scope: accounting.transactions.
 */
export async function getBankTransactions(
  fromDate: string,
  toDate: string,
  maxPages = 10,
): Promise<XeroBankTransaction[]> {
  const { accessToken, tenantId } = await getValidToken();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'xero-tenant-id': tenantId,
    Accept: 'application/json',
  };

  const where = `Date >= DateTime(${fromDate.replace(/-/g, ', ')}) && Date <= DateTime(${toDate.replace(/-/g, ', ')})`;
  const out: XeroBankTransaction[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${API_HOST}/api.xro/2.0/BankTransactions?where=${encodeURIComponent(where)}&order=Date%20DESC&page=${page}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body, page }, 'Xero /BankTransactions failed');
      throw new Error(`Xero BankTransactions failed: ${res.status}`);
    }
    const data = (await res.json()) as XeroBankTransactionsResponse;
    const txs = data.BankTransactions ?? [];
    if (txs.length === 0) break;

    for (const t of txs) {
      const isSpend = t.Type?.startsWith('SPEND');
      const total = Number(t.Total ?? 0);
      const signed = isSpend ? -Math.abs(total) : Math.abs(total);
      out.push({
        xeroBankTransactionId: t.BankTransactionID,
        xeroAccountId: t.BankAccount?.AccountID ?? null,
        date: parseXeroDate(t.Date),
        amount: signed.toFixed(2),
        currency: t.CurrencyCode ?? 'GBP',
        description: t.Reference || t.LineItems?.[0]?.Description || null,
        vendorName: t.Contact?.Name ?? null,
      });
    }
    if (txs.length < 100) break;
  }
  return out;
}

/**
 * Net VAT liability over a date range, computed from Xero's TaxSummary report.
 * `owed = collectedOnSales - paidOnPurchases`.
 *
 * Used by the VAT widget to show "VAT owed since end of last quarter".
 *
 * Required scope: accounting.reports.read.
 */
export async function getVatLiability(fromDate: string, toDate: string): Promise<XeroVatLiability> {
  const { accessToken, tenantId } = await getValidToken();
  const res = await fetch(
    `${API_HOST}/api.xro/2.0/Reports/TaxSummary?fromDate=${fromDate}&toDate=${toDate}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'xero-tenant-id': tenantId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    // 404 from Xero on TaxSummary almost always means the organisation isn't
    // VAT/GST-registered — the report endpoint literally doesn't exist for
    // non-tax orgs. Treat that as "no VAT to report" rather than an error so
    // the dashboard widget can render £0 cleanly instead of an error state.
    if (res.status === 404) {
      logger.warn({ body }, 'Xero TaxSummary 404 — organisation likely not VAT-registered, returning zeros');
      return {
        fromDate,
        toDate,
        owed: '0.00',
        collectedOnSales: '0.00',
        paidOnPurchases: '0.00',
      };
    }
    logger.error({ status: res.status, body }, 'Xero /Reports/TaxSummary failed');
    throw new Error(`Xero TaxSummary failed: ${res.status}`);
  }
  const data = (await res.json()) as XeroTaxSummaryResponse;
  const rows = data.Reports?.[0]?.Rows ?? [];

  const collectedOnSales = sumTaxSection(rows, 'Sales');
  const paidOnPurchases = sumTaxSection(rows, 'Purchases');
  const owed = collectedOnSales - paidOnPurchases;

  return {
    fromDate,
    toDate,
    owed: owed.toFixed(2),
    collectedOnSales: collectedOnSales.toFixed(2),
    paidOnPurchases: paidOnPurchases.toFixed(2),
  };
}

// ─── Invoice + Contact lookups (Sam's #32 "how do I connect his invoices?") ──

export interface XeroInvoice {
  xeroInvoiceId: string;
  invoiceNumber: string | null;
  status: string;           // DRAFT / SUBMITTED / AUTHORISED / PAID / VOIDED
  type: 'ACCREC' | 'ACCPAY' | string; // ACCREC = invoice we sent to a customer
  contactId: string;
  contactName: string;
  date: string | null;      // ISO YYYY-MM-DD
  dueDate: string | null;   // ISO YYYY-MM-DD
  currency: string;
  subtotal: string;         // decimal-on-wire
  totalTax: string;
  total: string;
  amountPaid: string;
  amountDue: string;
}

interface XeroInvoicesResponse {
  Invoices: Array<{
    InvoiceID: string;
    InvoiceNumber?: string;
    Status?: string;
    Type?: string;
    Contact?: { ContactID: string; Name?: string };
    Date?: string;          // /Date(...)/
    DueDate?: string;
    CurrencyCode?: string;
    SubTotal?: number;
    TotalTax?: number;
    Total?: number;
    AmountPaid?: number;
    AmountDue?: number;
  }>;
}

/**
 * Fetch all invoices in Xero for a given Contact (i.e. a single client).
 *
 * `Type==ACCREC` filters to sales invoices — invoices we sent the customer.
 * Default page size is 100; we follow the pagination header for completeness
 * even though most Sato clients won't have >100 invoices.
 *
 * Required scope: accounting.transactions (already in SCOPES).
 */
export async function getInvoicesForContact(contactId: string): Promise<XeroInvoice[]> {
  const { accessToken, tenantId } = await getValidToken();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'xero-tenant-id': tenantId,
    Accept: 'application/json',
  };

  const where = encodeURIComponent(`Contact.ContactID==Guid("${contactId}") && Type=="ACCREC"`);
  const out: XeroInvoice[] = [];

  // Xero paginates Invoices via ?page=N and returns up to 100 per page.
  for (let page = 1; page <= 10; page++) {
    const url = `${API_HOST}/api.xro/2.0/Invoices?where=${where}&order=Date%20DESC&page=${page}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body, contactId, page }, 'Xero /Invoices failed');
      throw new Error(`Xero /Invoices failed: ${res.status}`);
    }
    const data = (await res.json()) as XeroInvoicesResponse;
    const invs = data.Invoices ?? [];
    if (invs.length === 0) break;

    for (const i of invs) {
      out.push({
        xeroInvoiceId: i.InvoiceID,
        invoiceNumber: i.InvoiceNumber ?? null,
        status: i.Status ?? 'DRAFT',
        type: (i.Type as 'ACCREC') ?? 'ACCREC',
        contactId: i.Contact?.ContactID ?? contactId,
        contactName: i.Contact?.Name ?? '',
        date: i.Date ? parseXeroDate(i.Date) : null,
        dueDate: i.DueDate ? parseXeroDate(i.DueDate) : null,
        currency: i.CurrencyCode ?? 'GBP',
        subtotal: (i.SubTotal ?? 0).toFixed(2),
        totalTax: (i.TotalTax ?? 0).toFixed(2),
        total: (i.Total ?? 0).toFixed(2),
        amountPaid: (i.AmountPaid ?? 0).toFixed(2),
        amountDue: (i.AmountDue ?? 0).toFixed(2),
      });
    }
    if (invs.length < 100) break;
  }
  return out;
}

/**
 * Find a Xero Contact by exact name. Used when a Stato client has no
 * `xeroContactId` yet but Sam's seen the same company already exists in
 * Xero — we try to auto-link before giving up.
 *
 * Returns null if no exact-name match is found.
 *
 * Required scope: accounting.contacts (already in SCOPES).
 */
export async function findContactByName(name: string): Promise<XeroContact | null> {
  const { accessToken, tenantId } = await getValidToken();
  // Xero filter expressions need the value double-quoted; escape any double
  // quotes inside the name to keep the filter parseable.
  const safeName = name.replace(/"/g, '\\"');
  const where = encodeURIComponent(`Name=="${safeName}"`);
  const res = await fetch(
    `${API_HOST}/api.xro/2.0/Contacts?where=${where}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'xero-tenant-id': tenantId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body, name }, 'Xero /Contacts search failed');
    throw new Error(`Xero contact search failed: ${res.status}`);
  }
  const data = (await res.json()) as XeroContactsResponse;
  const first = data.Contacts?.[0];
  if (!first) return null;
  return { contactId: first.ContactID, name: first.Name };
}
