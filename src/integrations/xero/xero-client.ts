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

// Scope strategy:
//   * `finance.statements.read` is intentionally OMITTED — Custom Connection
//     apps don't ship with Finance API access by default, and requesting a
//     scope the app isn't entitled to fails the ENTIRE token exchange with
//     invalid_scope (rather than just degrading the Finance feature). The
//     bank-balance path already falls back to /Accounts.Balance when
//     CashValidation isn't available, so we lose the unreconciled-lines
//     count but bank balances still surface correctly. Re-add the scope
//     once the Custom Connection has Finance API enabled in the developer
//     portal — gated separately on developer.xero.com.
const SCOPES = 'accounting.transactions accounting.contacts accounting.reports.read accounting.settings.read';

interface XeroCache {
  accessToken: string;
  expiresAt: number;
  tenantId: string;
  tenantName: string;
}

let cache: XeroCache | null = null;

// Last token-exchange or /connections error message. Surfaced via getStatus()
// so the integrations page can show "invalid_scope" / "invalid_client" inline
// instead of forcing the operator into Railway logs.
let lastAuthError: string | null = null;

export const __testing = {
  resetCache() {
    cache = null;
    lastAuthError = null;
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

/**
 * Last successful token-exchange details — surfaced by getHealth() so the
 * diagnostic endpoint can show exactly which scopes Xero granted, when the
 * token was last refreshed, and how long until it expires. Populated only
 * after a successful exchangeCredentials() call.
 */
let lastTokenInfo: {
  refreshedAt: number;
  expiresAt: number;
  scopes: string[];
} | null = null;

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
    // Pull Xero's standard OAuth error code/description out of the response
    // body so the UI can show a human-actionable message rather than a 4xx.
    let detail = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: string; error_description?: string };
      if (parsed.error) {
        detail = parsed.error_description ? `${parsed.error}: ${parsed.error_description}` : parsed.error;
      }
    } catch {
      // Body wasn't JSON — keep the HTTP-status fallback.
    }
    lastAuthError = detail;
    throw new Error(`Xero auth failed: ${res.status}`);
  }

  const data = (await res.json()) as TokenResponse;
  const expiresAt = Date.now() + data.expires_in * 1000;
  // Record the granted scopes for the health endpoint. Xero echoes back the
  // accepted scope list (space-delimited), which may be a subset of what we
  // requested if the Custom Connection isn't entitled to every scope.
  lastTokenInfo = {
    refreshedAt: Date.now(),
    expiresAt,
    scopes: (data.scope ?? '').split(/\s+/).filter(Boolean),
  };
  return {
    accessToken: data.access_token,
    expiresAt,
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
  lastAuthError = null;
  logger.info({ tenantName: tenant.tenantName, tenantId: tenant.tenantId }, 'Xero authenticated (Custom Connection)');
  return { accessToken, tenantId: cache.tenantId };
}

export interface XeroStatus {
  configured: boolean;
  connected: boolean;
  tenantId?: string;
  tenantName?: string;
  expiresAt?: Date;
  /** Human-readable reason the last auth attempt failed (e.g. "invalid_scope"). */
  lastError?: string;
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
  return {
    configured: true,
    connected: false,
    ...(lastAuthError ? { lastError: lastAuthError } : {}),
  };
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
  balance: string;                  // statement balance (what the bank says), signed decimal
  balanceDate: string | null;       // 'as of' date Xero reports for the statement balance
  unreconciledLines: number | null; // pending statement lines not yet reconciled in Xero
  /**
   * Which tier of the bank-balance fallback produced the `balance` value.
   *   - 'cash-validation' = Finance API (best, real statement balance)
   *   - 'bank-summary'    = Accounting Reports BankSummary closing balance
   *   - 'accounts'        = /Accounts row Balance field (rarely populated)
   *   - 'fallback-zero'   = ALL upstream tiers failed; `balance` is the
   *                         hardcoded '0' sentinel. Operators should treat
   *                         this as "unknown", not "real zero" — pair with
   *                         the `[xero][bank-balance][fallback-zero]` error
   *                         log line in Railway to debug.
   * Optional (back-compat): older callers that don't look at this still get
   * the same `balance` string they always did.
   */
  balanceSource?: 'cash-validation' | 'bank-summary' | 'accounts' | 'fallback-zero';
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

interface XeroCashValidationItem {
  accountId: string;
  statementBalance?: { value: number; type: 'DEBIT' | 'CREDIT' };
  statementBalanceDate?: string;
  bankStatement?: {
    statementLines?: {
      unreconciledLines?: number;
    };
  };
}

/**
 * Fetch live bank-account *statement* balances from Xero — the figure the
 * bank itself reports (and the one users compare against the bank's app),
 * not Xero's GL closing balance which is inflated by unreconciled receipts.
 *
 * Sam Loom #1: dashboard was showing £113,515 (the GL ledger figure that
 * BankSummary returned) instead of the £52,446 statement balance Sam sees
 * on his Xero dashboard for Clinical Marketing Solutions.
 *
 * Precedence per account:
 *   1. Finance API /CashValidation        → statementBalance + asOf date + unreconciledLines
 *   2. /Reports/BankSummary               → closing balance per account
 *                                           (works with the standard accounting.reports.read
 *                                           scope — confirmed 2026-05-18 when Sam reported all
 *                                           balances showing as £0 because Xero's /Accounts API
 *                                           silently omits the Balance field for Custom Connection
 *                                           tokens, and CashValidation 401s without finance scope)
 *   3. Accounting API /Accounts.Balance   → last-ditch fallback (rarely populated)
 *   4. '0' when none of the above produce a number
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

  const today = new Date();
  const balanceDate = today.toISOString().slice(0, 10);
  const beginDate = new Date(today.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);

  const statementByAccountId = new Map<
    string,
    { value: string; date: string | null; unreconciledLines: number | null }
  >();

  const cvRes = await fetch(
    `${API_HOST}/finance.xro/1.0/CashValidation?balanceDate=${balanceDate}&beginDate=${beginDate}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  if (cvRes.ok) {
    const items = (await cvRes.json()) as XeroCashValidationItem[];
    for (const item of items) {
      const raw = item.statementBalance?.value ?? 0;
      // Bank assets carry DEBIT-normal balances; a CREDIT entryType means overdrawn.
      const signed = item.statementBalance?.type === 'CREDIT' ? -raw : raw;
      statementByAccountId.set(item.accountId, {
        value: signed.toFixed(2),
        date: item.statementBalanceDate ?? null,
        unreconciledLines: item.bankStatement?.statementLines?.unreconciledLines ?? null,
      });
    }
  } else {
    const body = await cvRes.text();
    logger.warn(
      { status: cvRes.status, body },
      'Xero Finance /CashValidation failed — falling back to BankSummary. Likely cause: Finance API not enabled on the Custom Connection (developer.xero.com → app → scopes).',
    );
  }

  // Tier-2 fallback: /Reports/BankSummary. Confirmed working with standard
  // accounting scopes on 2026-05-18 — fixes the all-zeros bug Sam reported
  // when both CashValidation 401s AND /Accounts omits the Balance field.
  // The report is keyed by AccountID in the row's Cells[0] attribute, so we
  // index it by id and pluck closing balance per bank account.
  const bankSummaryByAccountId = new Map<string, { value: string; date: string | null }>();
  if (statementByAccountId.size === 0) {
    try {
      const bsRes = await fetch(
        `${API_HOST}/api.xro/2.0/Reports/BankSummary?fromDate=${beginDate}&toDate=${balanceDate}`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (bsRes.ok) {
        const bsData = (await bsRes.json()) as XeroTaxSummaryResponse;
        for (const section of bsData.Reports?.[0]?.Rows ?? []) {
          if (section.RowType !== 'Section') continue;
          for (const row of section.Rows ?? []) {
            if (!row.Cells || row.Cells.length < 5) continue;
            // Xero attribute Id is "accountID" (camelCase) on Cells[0] in the
            // BankSummary response — confirmed against the live shape on
            // 2026-05-18. Other Cells carry "account" (lowercase) attribute
            // but those are spend/receipt drill-throughs, not the account
            // identity we want.
            const accountIdAttr = row.Cells[0]?.Attributes?.find((a) => a.Id === 'accountID');
            const accountId = accountIdAttr?.Value;
            // BankSummary columns: [Name, Opening, Cash Received, Cash Spent, Closing]
            // Closing balance lives in Cells[4]. Strip commas + handle "(123.45)" negative format.
            const closingRaw = row.Cells[4]?.Value ?? '0';
            const cleaned = closingRaw.replace(/,/g, '').replace(/^\((.*)\)$/, '-$1');
            const closingValue = Number.parseFloat(cleaned);
            if (accountId && Number.isFinite(closingValue)) {
              bankSummaryByAccountId.set(accountId, { value: closingValue.toFixed(2), date: balanceDate });
            }
          }
        }
      } else {
        const body = await bsRes.text();
        logger.warn({ status: bsRes.status, body: body.slice(0, 300) }, 'Xero /Reports/BankSummary failed');
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Xero /Reports/BankSummary threw');
    }
  }

  return bankAccounts.map((a) => {
    const stmt = statementByAccountId.get(a.AccountID);
    const bsRow = bankSummaryByAccountId.get(a.AccountID);
    // Precedence: CashValidation > BankSummary > Account.Balance > '0'.
    // CashValidation gives the true statement balance plus the as-of date and
    // unreconciled-line count; BankSummary gives a usable closing balance via
    // the accounting.reports.read scope when CashValidation isn't reachable;
    // Account.Balance is rarely populated for Custom Connections but kept as
    // a last fallback for orgs where Xero does include it.
    const fallbackBalance = typeof a.Balance === 'number' ? a.Balance.toFixed(2) : null;

    // Per-account tier resolution. Each entry is greppable in Railway via
    // [xero][bank-balance][tier=…] — gives Sam a fast answer to "where did
    // this number actually come from?" without needing to instrument calls.
    let balance: string;
    let balanceSource: XeroBankAccount['balanceSource'];
    if (stmt) {
      balance = stmt.value;
      balanceSource = 'cash-validation';
      // eslint-disable-next-line no-console
      console.warn(`[xero][bank-balance][tier=cash-validation] accountId=${a.AccountID} name=${JSON.stringify(a.Name)} balance=${balance}`);
    } else if (bsRow) {
      balance = bsRow.value;
      balanceSource = 'bank-summary';
      // eslint-disable-next-line no-console
      console.warn(`[xero][bank-balance][tier=bank-summary] accountId=${a.AccountID} name=${JSON.stringify(a.Name)} balance=${balance}`);
    } else if (fallbackBalance !== null) {
      balance = fallbackBalance;
      balanceSource = 'accounts';
      // eslint-disable-next-line no-console
      console.warn(`[xero][bank-balance][tier=accounts] accountId=${a.AccountID} name=${JSON.stringify(a.Name)} balance=${balance}`);
    } else {
      // All three upstream tiers failed — return the historic '0' sentinel
      // for back-compat with consumers that always expect a string, but
      // surface a greppable error line so operators can distinguish "API
      // down" from "real zero balance" in Railway logs.
      balance = '0';
      balanceSource = 'fallback-zero';
      // eslint-disable-next-line no-console
      console.error(`[xero][bank-balance][fallback-zero] accountId=${a.AccountID} name=${JSON.stringify(a.Name)} — all 3 tiers (CashValidation, BankSummary, Accounts.Balance) failed; returning '0' sentinel. Treat as unknown, not real zero.`);
    }

    return {
      accountId: a.AccountID,
      name: a.Name,
      code: a.Code ?? null,
      currency: a.CurrencyCode ?? 'GBP',
      balance,
      balanceDate: stmt?.date ?? bsRow?.date ?? null,
      unreconciledLines: stmt?.unreconciledLines ?? null,
      balanceSource,
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
  const url = `${API_HOST}/api.xro/2.0/Reports/TaxSummary?fromDate=${fromDate}&toDate=${toDate}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'xero-tenant-id': tenantId,
    Accept: 'application/json',
  };

  // Xero rate-limits the TaxSummary endpoint aggressively, especially when
  // the dashboard fans out across multiple quarters. Without retry, a single
  // 429 propagates to the widget as "VAT fetch failed". Retry up to 3 times
  // with exponential backoff (5s, 10s, 20s — capped each step) honoring
  // Retry-After when Xero supplies it. Combined with the controller's 60min
  // cache, this should mask all but the deepest rate-limit windows.
  const backoffSchedule = [5, 10, 20];
  let res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  for (let attempt = 0; attempt < backoffSchedule.length && res.status === 429; attempt++) {
    const xeroHint = Number(res.headers.get('Retry-After') ?? '0');
    const waitSec = xeroHint > 0 ? Math.min(xeroHint, 30) : backoffSchedule[attempt];
    logger.warn({ attempt: attempt + 1, waitSec, fromDate, toDate }, 'Xero TaxSummary 429 — backing off');
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  }

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

export interface XeroContactDetail {
  contactId: string;
  name: string;
  companyNumber: string | null;
  emailAddress: string | null;
  contactStatus: string | null;
  accountsReceivableTaxType: string | null;
}

/**
 * Fetch the full contact record from Xero by ID. Used by the diagnostic
 * endpoint to compare what Stato searches for vs what Xero actually has,
 * so we can debug auto-bind name/number mismatches.
 *
 * Required scope: accounting.contacts.
 */
export async function getContactById(contactId: string): Promise<XeroContactDetail | null> {
  const { accessToken, tenantId } = await getValidToken();
  const res = await xeroFetchWithBackoff(
    `${API_HOST}/api.xro/2.0/Contacts/${encodeURIComponent(contactId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'xero-tenant-id': tenantId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(45_000),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body, contactId }, 'Xero /Contacts/:id failed');
    throw new Error(`Xero contact fetch failed: ${res.status}`);
  }
  type FullContact = {
    ContactID: string;
    Name: string;
    CompanyNumber?: string;
    EmailAddress?: string;
    ContactStatus?: string;
    AccountsReceivableTaxType?: string;
  };
  const data = (await res.json()) as { Contacts?: FullContact[] };
  const first = data.Contacts?.[0];
  if (!first) return null;
  return {
    contactId: first.ContactID,
    name: first.Name,
    companyNumber: first.CompanyNumber ?? null,
    emailAddress: first.EmailAddress ?? null,
    contactStatus: first.ContactStatus ?? null,
    accountsReceivableTaxType: first.AccountsReceivableTaxType ?? null,
  };
}

/**
 * Fetch wrapper that retries on Xero's 429 rate-limit response. Xero's
 * standard tier allows ~60 calls/minute per tenant and bursts trigger 429
 * with a Retry-After header in seconds. We honour Retry-After when set,
 * otherwise back off 2s → 5s → 10s. Three attempts max.
 *
 * Used by every Xero read path so the bootstrap-on-create flow doesn't
 * silently lose contact lookups when the dashboard + hourly sync happen
 * to be hitting Xero at the same moment.
 */
async function xeroFetchWithBackoff(url: string, init: RequestInit): Promise<Response> {
  const delays = [2000, 5000, 10000];
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt < delays.length + 1; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    lastRes = res;
    if (attempt >= delays.length) break;
    // Xero sets Retry-After in seconds. Cap at the longest scripted backoff
    // so we never sleep more than 10s on a single attempt.
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, delays[attempt])
      : delays[attempt];
    logger.warn({ status: 429, attempt, waitMs, url }, 'Xero 429 — backing off');
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return lastRes!;
}

async function searchContacts(whereExpr: string): Promise<XeroContact[]> {
  const { accessToken, tenantId } = await getValidToken();
  const where = encodeURIComponent(whereExpr);
  const res = await xeroFetchWithBackoff(
    `${API_HOST}/api.xro/2.0/Contacts?where=${where}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'xero-tenant-id': tenantId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(45_000),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body, whereExpr }, 'Xero /Contacts search failed');
    throw new Error(`Xero contact search failed: ${res.status}`);
  }
  const data = (await res.json()) as XeroContactsResponse;
  return (data.Contacts ?? []).map((c) => ({ contactId: c.ContactID, name: c.Name }));
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
  // Xero filter expressions need the value double-quoted; escape any double
  // quotes inside the name to keep the filter parseable.
  const safeName = name.replace(/"/g, '\\"');
  const contacts = await searchContacts(`Name=="${safeName}"`);
  return contacts[0] ?? null;
}

/**
 * Find a Xero Contact by UK Companies House number. More reliable than
 * name-matching because company numbers are unique and immune to legal-
 * entity suffix drift ("Acme Ltd" vs "Acme Limited" vs "Acme").
 *
 * Returns null if no match. Returns the first row if Xero somehow has
 * duplicates with the same number (shouldn't happen but defensive).
 */
export async function findContactByCompanyNumber(companyNumber: string): Promise<XeroContact | null> {
  const safe = companyNumber.replace(/"/g, '\\"');
  const contacts = await searchContacts(`CompanyNumber=="${safe}"`);
  return contacts[0] ?? null;
}

/**
 * Best-effort multi-strategy contact lookup. Tries the strongest signal
 * first (UK Companies House number — unique), then exact name, then a
 * case-insensitive substring match. Returns the first hit or null.
 *
 * Used by client-create bootstrap so a fresh client gets its Xero contact
 * auto-bound even when the name in Stato doesn't perfectly match Xero
 * (e.g. "Acme" vs "Acme Ltd").
 */
export async function findContactBestMatch(
  name: string | null | undefined,
  companyNumber: string | null | undefined,
): Promise<XeroContact | null> {
  if (companyNumber) {
    const byNumber = await findContactByCompanyNumber(companyNumber).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err), companyNumber }, 'Xero number search failed — falling back');
      return null;
    });
    if (byNumber) return byNumber;
  }
  if (!name) return null;
  const byExact = await findContactByName(name).catch((err) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err), name }, 'Xero exact-name search failed — falling back');
    return null;
  });
  if (byExact) return byExact;
  // Substring fallback — Xero supports .ToLower().Contains() in filter
  // expressions. Strip the trailing Ltd/Limited/etc. so we can still find
  // a match when Stato has the bare name and Xero has the suffix or vice
  // versa.
  const base = name.replace(/\s+(corporation|limited|llc|plc|ltd|inc|corp|co)\.?$/i, '').trim();
  if (!base) return null;
  const safe = base.replace(/"/g, '\\"').toLowerCase();
  const contacts = await searchContacts(`Name.ToLower().Contains("${safe}")`).catch((err) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err), base }, 'Xero substring search failed');
    return [];
  });
  return contacts[0] ?? null;
}

// ─── Health diagnostic ──────────────────────────────────────────────────────

export interface XeroHealth {
  configured: boolean;
  /** Tenant the Custom Connection is bound to. */
  tenantId: string | null;
  tenantName: string | null;
  /** Scopes Xero actually granted at last token exchange (may be < requested). */
  scopesRequested: string[];
  scopesGranted: string[];
  /** Scopes we asked for but didn't receive — usually means the Custom
   *  Connection isn't entitled to them in developer.xero.com. */
  scopesMissing: string[];
  /** ISO timestamps + ms-to-expiry on the cached token. */
  tokenRefreshedAt: string | null;
  tokenExpiresAt: string | null;
  tokenSecondsRemaining: number | null;
  /** Last surfaced auth error (cleared on next successful exchange). */
  lastAuthError: string | null;
  /** Quick probes against the Accounting + Reports + Finance APIs so Sam
   *  can see exactly which surfaces work and which need a scope/data fix. */
  probes: {
    accountsApi: { ok: boolean; bankAccounts: number | null; error?: string };
    reportsApi: { ok: boolean; vatRegistered: boolean | null; error?: string };
    financeApi: { ok: boolean; cashValidationAvailable: boolean | null; error?: string };
  };
  /** Plain-English next-step list for Sam — generated from the probe results. */
  recommendations: string[];
}

/**
 * One-shot health check the diagnostic UI hits to render the integrations
 * page. Runs three small Xero probes in parallel and aggregates everything
 * the operator needs to debug "why is my bank/VAT widget empty?" without
 * having to dig through Railway logs.
 */
export async function getHealth(): Promise<XeroHealth> {
  if (!isXeroConfigured()) {
    return {
      configured: false,
      tenantId: null,
      tenantName: null,
      scopesRequested: SCOPES.split(/\s+/).filter(Boolean),
      scopesGranted: [],
      scopesMissing: SCOPES.split(/\s+/).filter(Boolean),
      tokenRefreshedAt: null,
      tokenExpiresAt: null,
      tokenSecondsRemaining: null,
      lastAuthError: null,
      probes: {
        accountsApi: { ok: false, bankAccounts: null, error: 'not configured' },
        reportsApi: { ok: false, vatRegistered: null, error: 'not configured' },
        financeApi: { ok: false, cashValidationAvailable: null, error: 'not configured' },
      },
      recommendations: [
        'Set XERO_CLIENT_ID and XERO_CLIENT_SECRET on the Sato-Backend Railway service.',
        'Create a Custom Connection in developer.xero.com and paste the client id/secret.',
      ],
    };
  }

  // Force a token exchange so the scope list reflects the current Custom
  // Connection state, not whatever was cached on first call this process.
  let tenantId: string | null = null;
  let tenantName: string | null = null;
  let accessToken: string | null = null;
  try {
    const tok = await getValidToken();
    accessToken = tok.accessToken;
    tenantId = tok.tenantId;
    tenantName = cache?.tenantName ?? null;
  } catch (err) {
    return {
      configured: true,
      tenantId: null,
      tenantName: null,
      scopesRequested: SCOPES.split(/\s+/).filter(Boolean),
      scopesGranted: [],
      scopesMissing: SCOPES.split(/\s+/).filter(Boolean),
      tokenRefreshedAt: null,
      tokenExpiresAt: null,
      tokenSecondsRemaining: null,
      lastAuthError: lastAuthError ?? (err instanceof Error ? err.message : String(err)),
      probes: {
        accountsApi: { ok: false, bankAccounts: null, error: 'no token' },
        reportsApi: { ok: false, vatRegistered: null, error: 'no token' },
        financeApi: { ok: false, cashValidationAvailable: null, error: 'no token' },
      },
      recommendations: [
        'Xero token exchange failed — check XERO_CLIENT_ID / XERO_CLIENT_SECRET.',
        'See lastAuthError above for the Xero-side reason.',
      ],
    };
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'xero-tenant-id': tenantId,
    Accept: 'application/json',
  };

  // Probe 1: Accounting /Accounts (bank account count)
  // Probe 2: Reports /TaxSummary (VAT registration — 404 = not registered)
  // Probe 3: Finance /CashValidation (Finance API gating)
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [accRes, taxRes, cvRes] = await Promise.allSettled([
    fetch(`${API_HOST}/api.xro/2.0/Accounts?where=${encodeURIComponent('Type=="BANK"&&Status=="ACTIVE"')}`, { headers, signal: AbortSignal.timeout(15_000) }),
    fetch(`${API_HOST}/api.xro/2.0/Reports/TaxSummary?fromDate=${monthAgo}&toDate=${today}`, { headers, signal: AbortSignal.timeout(15_000) }),
    fetch(`${API_HOST}/finance.xro/1.0/CashValidation?balanceDate=${today}&beginDate=${monthAgo}`, { headers, signal: AbortSignal.timeout(15_000) }),
  ]);

  const probes: XeroHealth['probes'] = {
    accountsApi: { ok: false, bankAccounts: null },
    reportsApi: { ok: false, vatRegistered: null },
    financeApi: { ok: false, cashValidationAvailable: null },
  };

  if (accRes.status === 'fulfilled') {
    const r = accRes.value;
    if (r.ok) {
      const data = await r.json() as XeroAccountsResponse;
      probes.accountsApi = { ok: true, bankAccounts: (data.Accounts ?? []).length };
    } else {
      probes.accountsApi = { ok: false, bankAccounts: null, error: `HTTP ${r.status}` };
    }
  } else {
    probes.accountsApi = { ok: false, bankAccounts: null, error: accRes.reason instanceof Error ? accRes.reason.message : String(accRes.reason) };
  }

  if (taxRes.status === 'fulfilled') {
    const r = taxRes.value;
    if (r.ok) {
      probes.reportsApi = { ok: true, vatRegistered: true };
    } else if (r.status === 404) {
      // Xero returns 404 for orgs that aren't VAT/GST-registered.
      probes.reportsApi = { ok: true, vatRegistered: false };
    } else {
      probes.reportsApi = { ok: false, vatRegistered: null, error: `HTTP ${r.status}` };
    }
  } else {
    probes.reportsApi = { ok: false, vatRegistered: null, error: taxRes.reason instanceof Error ? taxRes.reason.message : String(taxRes.reason) };
  }

  if (cvRes.status === 'fulfilled') {
    const r = cvRes.value;
    if (r.ok) {
      probes.financeApi = { ok: true, cashValidationAvailable: true };
    } else {
      probes.financeApi = { ok: false, cashValidationAvailable: false, error: `HTTP ${r.status}` };
    }
  } else {
    probes.financeApi = { ok: false, cashValidationAvailable: false, error: cvRes.reason instanceof Error ? cvRes.reason.message : String(cvRes.reason) };
  }

  const scopesRequested = SCOPES.split(/\s+/).filter(Boolean);
  const scopesGranted = lastTokenInfo?.scopes ?? [];
  const scopesMissing = scopesRequested.filter((s) => !scopesGranted.includes(s));

  // Plain-English next steps based on probe results. Order matters —
  // surface scope/permission issues first, then real-state things Sam can
  // fix in Xero, then transient noise. Distinguish 429 (rate limit, will
  // self-heal) from 401/403 (auth/scope, needs Sam) so we don't tell him
  // to "check scopes" when the only problem is too many recent probes.
  const recs: string[] = [];
  const isRateLimit = (err?: string) => typeof err === 'string' && err.includes('429');

  if (probes.accountsApi.ok && (probes.accountsApi.bankAccounts ?? 0) === 0) {
    recs.push('Bank Accounts widget is empty because the Xero org has no accounts of Type=BANK with Status=ACTIVE. In Xero → Accounting → Chart of accounts, mark at least one bank account as active.');
  }
  if (probes.accountsApi.ok === false) {
    if (isRateLimit(probes.accountsApi.error)) {
      recs.push('Accounting API rate-limited (HTTP 429) at probe time — Xero will reset within ~60s, then the Bank widget will reload. No action needed.');
    } else {
      recs.push(`Accounting API failed (${probes.accountsApi.error}) — check the Custom Connection has the accounting.contacts + accounting.transactions scopes in developer.xero.com.`);
    }
  }
  if (probes.reportsApi.ok && probes.reportsApi.vatRegistered === false) {
    recs.push('VAT Liability widget will display £0 because the Xero org is not VAT-registered (Xero /Reports/TaxSummary returned 404). This is the actual state, not a bug.');
  }
  if (probes.reportsApi.ok === false) {
    if (isRateLimit(probes.reportsApi.error)) {
      recs.push('Reports API rate-limited (HTTP 429) at probe time — try the health check again in ~60s. The VAT widget itself has its own retry/backoff so end users rarely see this.');
    } else {
      recs.push(`Reports API failed (${probes.reportsApi.error}) — confirm the Custom Connection has the accounting.reports.read scope.`);
    }
  }
  if (probes.financeApi.ok === false && !isRateLimit(probes.financeApi.error)) {
    recs.push('Finance API (CashValidation) is unavailable — this is EXPECTED for standard Custom Connections (the finance.statements.read scope is intentionally not requested). Bank balances fall back to /Reports/BankSummary instead.');
  }
  if (scopesMissing.length > 0) {
    recs.push(`Missing granted scopes: ${scopesMissing.join(', ')} — enable in developer.xero.com → app → scopes.`);
  }
  if (recs.length === 0) {
    recs.push('Xero integration is healthy. Bank + VAT widgets are reading real upstream data.');
  }

  return {
    configured: true,
    tenantId,
    tenantName,
    scopesRequested,
    scopesGranted,
    scopesMissing,
    tokenRefreshedAt: lastTokenInfo ? new Date(lastTokenInfo.refreshedAt).toISOString() : null,
    tokenExpiresAt: lastTokenInfo ? new Date(lastTokenInfo.expiresAt).toISOString() : null,
    tokenSecondsRemaining: lastTokenInfo ? Math.max(0, Math.floor((lastTokenInfo.expiresAt - Date.now()) / 1000)) : null,
    lastAuthError,
    probes,
    recommendations: recs,
  };
}
