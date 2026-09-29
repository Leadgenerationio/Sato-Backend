import { createHash } from 'node:crypto';

// Thin client for the Stato public REST API (docs/creative-library-and-api-plan.md,
// phase 2). Every call authenticates with an API key in `X-API-Key`; the key's
// scopes decide what the MCP tools can do — this server adds no rights of its own.

export interface StatoApiOptions {
  baseUrl: string; // e.g. https://sato-backend-production.up.railway.app
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class StatoApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'StatoApiError';
  }
}

const PLAIN: Record<number, string> = {
  400: 'Stato rejected the request',
  401: 'The Stato API key is missing, wrong or revoked',
  403: "This Stato API key doesn't have permission for that",
  404: 'Not found in Stato',
  409: 'That conflicts with something already in Stato',
  413: 'The file is too large for Stato',
  422: 'Stato could not accept that',
  429: 'Too many requests to Stato — wait a minute and try again',
};

export interface UploadCreativeInput {
  platform: string;
  accountId?: string;
  clientId?: string;
  campaignId?: string;
  sourceUrl: string;
  landingPageUrl?: string;
  headline?: string;
  bodyText?: string;
  platformAdId?: string;
  platformCreativeId?: string;
  idempotencyKey?: string;
}

/**
 * Stable key for a creative upload so a retried tool call (an assistant
 * re-sending the same request) can't create a duplicate. Prefers the
 * platform's own creative id; otherwise hashes the request.
 */
export function idempotencyKeyFor(input: UploadCreativeInput): string {
  if (input.idempotencyKey) return input.idempotencyKey;
  const basis = input.platformCreativeId
    ? `${input.platform}:${input.platformCreativeId}`
    : JSON.stringify([input.platform, input.accountId ?? '', input.clientId ?? '', input.sourceUrl, input.landingPageUrl ?? '', input.platformAdId ?? '']);
  return `mcp-${createHash('sha256').update(basis).digest('hex').slice(0, 40)}`;
}

export class StatoApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: StatoApiOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async call<T>(method: string, path: string, { query, body, headers }: {
    query?: Record<string, string | number | undefined>; body?: unknown; headers?: Record<string, string>;
  } = {}): Promise<T> {
    const url = new URL(`${this.base}/api/v1${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          'X-API-Key': this.opts.apiKey,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new StatoApiError(0, `Couldn't reach Stato (${(err as Error).message}). Nothing was changed.`);
    }
    const text = await res.text();
    let json: { status?: string; message?: string; data?: unknown; errors?: Array<{ path?: string; message?: string }> } | undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (!res.ok) {
      const detail = json?.errors?.[0] ? ` (${[json.errors[0].path, json.errors[0].message].filter(Boolean).join(': ')})` : '';
      const base = json?.message ?? PLAIN[res.status] ?? (res.status >= 500 ? 'Stato had a problem — try again shortly' : `Stato answered HTTP ${res.status}`);
      throw new StatoApiError(res.status, `${base}${detail}`);
    }
    // `data: null` is a real answer (e.g. nothing found) — don't fall back to the envelope.
    return (json && typeof json === 'object' && 'data' in json ? json.data : json) as T;
  }

  findClientByAdAccount(platform: string, accountId: string) {
    return this.call<unknown>('GET', '/clients/lookup', { query: { platform, accountId } });
  }

  linkAdAccount(clientId: string, input: { platform: string; accountId: string; campaignId?: string; currency?: string }) {
    return this.call<unknown>('POST', `/clients/${encodeURIComponent(clientId)}/ad-accounts`, { body: input });
  }

  uploadCreative(input: UploadCreativeInput) {
    const { idempotencyKey: _k, ...body } = input;
    return this.call<unknown>('POST', '/creatives', { body, headers: { 'Idempotency-Key': idempotencyKeyFor(input) } });
  }

  listCreatives(q: { clientId?: string; platform?: string; landingPage?: string; q?: string; sort?: string; page?: number }) {
    return this.call<unknown>('GET', '/creatives', { query: q });
  }

  attachLandingPage(creativeId: string, url: string) {
    return this.call<unknown>('POST', `/creatives/${encodeURIComponent(creativeId)}/landing-page`, { body: { url } });
  }
}
