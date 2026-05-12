/**
 * Minimal 5-field cron next-fire calculator. Slice 5 Day 4.
 *
 * Spec: standard "minute hour day-of-month month day-of-week" cron
 * (no seconds, no L/W/#). Each field supports `*`, comma lists,
 * ranges (`a-b`), step values (`* / n` or `a-b / n`).
 *
 * Strategy: brute-force minute-by-minute starting from `from + 1 min`,
 * test each field, return first match. Bounded at 366 days so a
 * bogus or impossible expression doesn't spin forever.
 *
 * Day-of-week: 0 = Sunday … 6 = Saturday. POSIX semantics — when both
 * `dom` and `dow` are restricted, a match on EITHER field qualifies
 * (matches GNU/BSD cron). When only one is restricted, that one rules.
 */

const RANGES: Record<'minute' | 'hour' | 'dom' | 'month' | 'dow', [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
};

type FieldKey = keyof typeof RANGES;

export class CronParseError extends Error {
  constructor(public expr: string, message: string) {
    super(`Invalid cron expression "${expr}": ${message}`);
    this.name = 'CronParseError';
  }
}

function parseField(raw: string, key: FieldKey, expr: string): Set<number> {
  const [min, max] = RANGES[key];
  const allowed = new Set<number>();
  for (const part of raw.split(',')) {
    if (!part) throw new CronParseError(expr, `empty list element in ${key}`);
    const stepMatch = part.split('/');
    if (stepMatch.length > 2) throw new CronParseError(expr, `bad step in ${key}: ${part}`);
    const [rangePart, stepPart] = stepMatch;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new CronParseError(expr, `bad step value in ${key}: ${stepPart}`);

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new CronParseError(expr, `bad range in ${key}: ${rangePart}`);
      }
      lo = a;
      hi = b;
    } else {
      const v = Number(rangePart);
      if (!Number.isInteger(v)) throw new CronParseError(expr, `bad value in ${key}: ${rangePart}`);
      lo = v;
      hi = v;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new CronParseError(expr, `${key} out of range ${min}-${max}: ${rangePart}`);
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  dom: Set<number>;
  months: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parse(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(expr, `expected 5 fields, got ${fields.length}`);
  }
  const [m, h, dm, mo, dw] = fields;
  return {
    minutes: parseField(m, 'minute', expr),
    hours: parseField(h, 'hour', expr),
    dom: parseField(dm, 'dom', expr),
    months: parseField(mo, 'month', expr),
    dow: parseField(dw, 'dow', expr),
    domRestricted: dm !== '*',
    dowRestricted: dw !== '*',
  };
}

const MAX_MINUTES = 366 * 24 * 60; // bail after 1 year of advancing

/**
 * Returns the next datetime AFTER `from` at which `expr` fires.
 * Resolution is to the minute (cron's native unit). Always returns
 * a date strictly greater than `from`.
 */
export function cronNextFire(expr: string, from: Date = new Date()): Date {
  const p = parse(expr);
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < MAX_MINUTES; i++) {
    const minute = candidate.getMinutes();
    const hour = candidate.getHours();
    const dom = candidate.getDate();
    const month = candidate.getMonth() + 1; // JS is 0-based
    const dow = candidate.getDay();

    const domMatch = p.dom.has(dom);
    const dowMatch = p.dow.has(dow);
    // POSIX cron: if BOTH dom & dow are restricted, EITHER match wins.
    // If only one is restricted, that one rules. If neither, both pass.
    let dayMatches: boolean;
    if (p.domRestricted && p.dowRestricted) dayMatches = domMatch || dowMatch;
    else if (p.domRestricted) dayMatches = domMatch;
    else if (p.dowRestricted) dayMatches = dowMatch;
    else dayMatches = true;

    if (
      p.minutes.has(minute) &&
      p.hours.has(hour) &&
      p.months.has(month) &&
      dayMatches
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new CronParseError(expr, 'no next fire found within 1 year — likely impossible expression');
}

/**
 * Cheap validity check — parses without throwing on caller side.
 */
export function isValidCron(expr: string): boolean {
  try {
    parse(expr);
    return true;
  } catch {
    return false;
  }
}
