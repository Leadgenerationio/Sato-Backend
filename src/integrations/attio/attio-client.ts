import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

// #39 Attio bulk import. Thin fetch wrapper around the Attio v2 API.
//
// Endpoints we use:
//   POST /objects/companies/records/query  — list/search companies
//   GET  /objects/companies/records/:recordId  — fetch one
//
// Attio's company records are objects with `id.record_id` (UUID) and a
// `values` map keyed by slug → array of typed values (one per value
// type). The shape is generic — we narrow to the fields we want here.

export interface AttioCompany {
  recordId: string;
  name: string | null;
  domain: string | null;       // primary domain, first value
  description: string | null;
  industry: string | null;
  employeeRange: string | null;
}

export class AttioNotConfiguredError extends Error {
  constructor() {
    super('ATTIO_API_KEY not configured');
    this.name = 'AttioNotConfiguredError';
  }
}

export function isAttioConfigured(): boolean {
  return !!process.env.ATTIO_API_KEY;
}

function apiKey(): string {
  // Read process.env at call time so rotation works without restart.
  const k = process.env.ATTIO_API_KEY;
  if (!k) throw new AttioNotConfiguredError();
  return k;
}

function baseUrl(): string {
  return process.env.ATTIO_BASE_URL || env.ATTIO_BASE_URL;
}

interface AttioValue {
  value?: string;
  domain?: string;
  // Attio also exposes status/option/select objects with `option.title` etc.
  // We only narrow `value` and `domain` for the fields we read.
}

interface AttioRecord {
  id: { record_id: string };
  values: Record<string, AttioValue[] | undefined>;
}

interface AttioListResponse {
  data?: AttioRecord[];
  // Attio's cursor pagination lives in `pagination.next` — keep it
  // generic so callers can pass it back as `cursor` on the next call.
  pagination?: { next?: string | null };
}

function firstString(values: AttioValue[] | undefined): string | null {
  if (!values || values.length === 0) return null;
  const v = values[0];
  return v.value ?? v.domain ?? null;
}

function recordToCompany(r: AttioRecord): AttioCompany {
  return {
    recordId: r.id.record_id,
    name: firstString(r.values.name),
    domain: firstString(r.values.domains),
    description: firstString(r.values.description),
    industry: firstString(r.values.industry),
    employeeRange: firstString(r.values.employee_range ?? r.values.estimated_arr),
  };
}

export interface ListAttioCompaniesOpts {
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface ListAttioCompaniesResult {
  companies: AttioCompany[];
  nextCursor: string | null;
}

export async function listAttioCompanies(
  opts: ListAttioCompaniesOpts = {},
): Promise<ListAttioCompaniesResult> {
  const body: Record<string, unknown> = {
    limit: Math.min(100, Math.max(1, opts.limit ?? 50)),
  };
  if (opts.cursor) body.cursor = opts.cursor;
  if (opts.search && opts.search.trim()) {
    // Attio query filter: match on `name` contains. The exact filter
    // grammar is documented per-object; this is the canonical shape for
    // a substring search on the company name attribute.
    body.filter = {
      name: { '$contains': opts.search.trim() },
    };
  }

  const res = await fetch(`${baseUrl()}/objects/companies/records/query`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn({ status: res.status, body: text.slice(0, 200) }, 'Attio list returned non-2xx');
    throw new Error(`Attio ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as AttioListResponse;
  return {
    companies: (json.data ?? []).map(recordToCompany),
    nextCursor: json.pagination?.next ?? null,
  };
}

export async function getAttioCompany(recordId: string): Promise<AttioCompany | null> {
  const res = await fetch(`${baseUrl()}/objects/companies/records/${recordId}`, {
    headers: { authorization: `Bearer ${apiKey()}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Attio ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: AttioRecord };
  return json.data ? recordToCompany(json.data) : null;
}
