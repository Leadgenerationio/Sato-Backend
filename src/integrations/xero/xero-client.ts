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
 * Combines:
 *   1. /Accounts?where=Type=="BANK"  → list of bank accounts with currency + name
 *   2. /Reports/BankSummary           → each account's closing balance (today)
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
    { headers },
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
    { headers },
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

  return bankAccounts.map((a) => ({
    accountId: a.AccountID,
    name: a.Name,
    code: a.Code ?? null,
    currency: a.CurrencyCode ?? 'GBP',
    balance: balanceByAccountId.get(a.AccountID) ?? '0',
  }));
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
    const res = await fetch(url, { headers });
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
    },
  );
  if (!res.ok) {
    const body = await res.text();
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
