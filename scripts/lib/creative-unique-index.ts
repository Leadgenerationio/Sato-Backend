import type postgres from 'postgres';

// The same file for the same client is one creative (spec v1.0 section 2.1). The code checks it; this makes the database
// enforce it too. CREATE INDEX CONCURRENTLY cannot run inside a transaction, so it is a script, not a migration, and it
// refuses to run while duplicates exist (they would make the build fail and leave an INVALID index behind).

export type Sql = postgres.Sql;
export const INDEX_NAME = 'creatives_client_sha256_live_uq';
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

export interface DuplicateGroup { clientId: string; sha256: string; count: number; ids: string[] }

/** Live creatives that share (client, file hash): what the unique index would refuse. */
export async function findDuplicateGroups(sql: Sql, table = 'creatives'): Promise<DuplicateGroup[]> {
  const rows = await sql.unsafe(
    `select client_id, sha256, count(*)::int as n, array_agg(id::text order by created_at, id) as ids
       from ${ident(table)}
      where sha256 is not null and client_id is not null and is_deleted = false
      group by client_id, sha256 having count(*) > 1
      order by n desc, client_id`,
  );
  return rows.map((r) => ({ clientId: r.client_id as string, sha256: (r.sha256 as string).trim(), count: r.n as number, ids: r.ids as string[] }));
}

export const createIndexSql = (table = 'creatives', name = INDEX_NAME) =>
  `create unique index concurrently ${ident(name)} on ${ident(table)} (client_id, sha256) where sha256 is not null and client_id is not null and is_deleted = false`;

export interface IndexState { exists: boolean; valid: boolean }

export async function indexState(sql: Sql, name = INDEX_NAME): Promise<IndexState> {
  const rows = await sql`select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = ${name} and c.relkind = 'i'`;
  return { exists: rows.length > 0, valid: rows.length > 0 && Boolean(rows[0]!.valid) };
}

export type IndexResult = 'created' | 'already_there' | 'rebuilt' | 'refused_duplicates' | 'failed';

/**
 * Create the unique index safely: refuse while duplicates exist, leave a valid index alone, drop and rebuild an INVALID one
 * (a failed concurrent build leaves one behind), and check indisvalid afterwards.
 */
export async function ensureUniqueIndex(sql: Sql, opts: { table?: string; name?: string; dryRun?: boolean; log?: (m: string) => void } = {}): Promise<{ result: IndexResult; duplicates: DuplicateGroup[]; sql: string }> {
  const table = opts.table ?? 'creatives'; const name = opts.name ?? INDEX_NAME; const log = opts.log ?? (() => {});
  const statement = createIndexSql(table, name);
  const duplicates = await findDuplicateGroups(sql, table);
  if (duplicates.length) { log(`${duplicates.length} group(s) of duplicates: not creating the index`); return { result: 'refused_duplicates', duplicates, sql: statement }; }
  const state = await indexState(sql, name);
  if (state.exists && state.valid) { log('index already exists and is valid'); return { result: 'already_there', duplicates, sql: statement }; }
  if (opts.dryRun) { log(`dry run: would run ${state.exists ? `drop index concurrently ${ident(name)}, then ` : ''}${statement}`); return { result: state.exists ? 'rebuilt' : 'created', duplicates, sql: statement }; }
  if (state.exists) { log('an INVALID index was left by a failed build: dropping it'); await sql.unsafe(`drop index concurrently if exists ${ident(name)}`); }
  try {
    await sql.unsafe(statement);
  } catch (err) {
    log(`create index failed: ${err instanceof Error ? err.message : String(err)}`);
    await sql.unsafe(`drop index concurrently if exists ${ident(name)}`).catch(() => {});
    return { result: 'failed', duplicates, sql: statement };
  }
  const after = await indexState(sql, name);
  if (!after.valid) { await sql.unsafe(`drop index concurrently if exists ${ident(name)}`).catch(() => {}); log('the index came out INVALID and was dropped'); return { result: 'failed', duplicates, sql: statement }; }
  return { result: state.exists ? 'rebuilt' : 'created', duplicates, sql: statement };
}
