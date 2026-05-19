/**
 * Time-window key accepted by the dashboard stats + campaign list endpoints.
 *
 * Mirrors the LeadByte DeliveryWindow names for the overlapping options so
 * the campaign-report cache can be reused without an extra LeadByte call,
 * and adds rolling-day variants for the longer-tail filters the dashboard
 * dropdown surfaces.
 */
export type DashboardWindow =
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'last_90d'
  | 'last_6m'
  | 'last_year';

export interface ResolvedWindow {
  /** Inclusive lower bound (ISO YYYY-MM-DD). */
  startIso: string;
  /** Inclusive upper bound (ISO YYYY-MM-DD). */
  endIso: string;
  /** Lower bound of the previous equivalent window — for trend deltas. */
  prevStartIso: string;
  /** Upper bound of the previous equivalent window. */
  prevEndIso: string;
  /** Human-readable label, e.g. "Last 90 days". */
  label: string;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Convert a DashboardWindow key into a concrete date range + the prior
 * equivalent range for trend-delta math. All dates are UTC ISO YYYY-MM-DD.
 *
 * For rolling windows ("last_90d") prev = the equivalent-length window
 * immediately preceding. For calendar windows ("this_month") prev = the
 * previous calendar period.
 */
export function resolveDashboardWindow(key: DashboardWindow, now: Date = new Date()): ResolvedWindow {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayIso = ymd(today);

  const rollingDays = (days: number, label: string): ResolvedWindow => {
    const start = new Date(today.getTime() - (days - 1) * 86400000);
    const prevEnd = new Date(start.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);
    return {
      startIso: ymd(start),
      endIso: todayIso,
      prevStartIso: ymd(prevStart),
      prevEndIso: ymd(prevEnd),
      label,
    };
  };

  switch (key) {
    case 'this_week':
      return rollingDays(7, 'Last 7 days');
    case 'this_month': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const prevEnd = new Date(start.getTime() - 86400000);
      const prevStart = new Date(Date.UTC(prevEnd.getUTCFullYear(), prevEnd.getUTCMonth(), 1));
      return {
        startIso: ymd(start),
        endIso: todayIso,
        prevStartIso: ymd(prevStart),
        prevEndIso: ymd(prevEnd),
        label: 'This month',
      };
    }
    case 'last_month': {
      const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const lastMonthEnd = new Date(thisMonthStart.getTime() - 86400000);
      const lastMonthStart = new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 1));
      const prevEnd = new Date(lastMonthStart.getTime() - 86400000);
      const prevStart = new Date(Date.UTC(prevEnd.getUTCFullYear(), prevEnd.getUTCMonth(), 1));
      return {
        startIso: ymd(lastMonthStart),
        endIso: ymd(lastMonthEnd),
        prevStartIso: ymd(prevStart),
        prevEndIso: ymd(prevEnd),
        label: 'Last month',
      };
    }
    case 'last_90d':
      return rollingDays(90, 'Last 90 days');
    case 'last_6m':
      return rollingDays(180, 'Last 6 months');
    case 'last_year':
      return rollingDays(365, 'Last 12 months');
  }
}

/**
 * Map a DashboardWindow → the matching LeadByte DeliveryWindow cache key
 * when one exists, so the campaign-report fetch can hit Redis instead of
 * issuing a fresh API call. Returns null when there's no direct match
 * (the caller should fall back to summing the available cache windows).
 */
export function dashboardWindowToLeadByteCacheKey(key: DashboardWindow): string | null {
  switch (key) {
    case 'this_week': return 'this_week';
    case 'this_month': return 'this_month';
    case 'last_month': return 'last_month';
    case 'last_year': return 'ytd';
    // last_90d, last_6m don't map cleanly to LeadByte presets — caller
    // sums month+last_month or falls back to a windowed query.
    case 'last_90d':
    case 'last_6m':
    default:
      return null;
  }
}

/** Type guard / parser for incoming `?window=` query params. */
export function parseDashboardWindow(input: unknown): DashboardWindow | null {
  if (typeof input !== 'string') return null;
  const allowed: readonly DashboardWindow[] = [
    'this_week', 'this_month', 'last_month', 'last_90d', 'last_6m', 'last_year',
  ];
  return (allowed as readonly string[]).includes(input) ? (input as DashboardWindow) : null;
}
