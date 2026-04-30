import rateLimit from 'express-rate-limit';

// Active admin sessions easily exceed 100 req / 15 min:
// dashboard polls every 30s (~30 r/15m), LeadByte hooks poll every 90s
// (~10 r/15m), plus pagination, categorise clicks, and notification badge
// fetches. The previous 100/15m cap tripped Sam's bank-feed categorise
// flow with "Too many requests, please try again later". 1500/15m =
// ~100 rpm leaves comfortable headroom for normal use; abusive clients
// still hit the wall. Auth limiter stays tight (login brute-force).
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const GENERAL_LIMIT_MAX = 1500;
export const AUTH_LIMIT_MAX = 20;

export const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: GENERAL_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests, please try again later' },
});

export const authLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: AUTH_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many login attempts, please try again later' },
});
