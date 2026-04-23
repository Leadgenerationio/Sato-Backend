# Stato Backend — Production Deploy Runbook

Step-by-step for promoting `Development` → production (Railway) for the
first time. Subsequent deploys can skip steps 1–4.

---

## 1. Generate prod secrets (one-time)

Run on a trusted machine, paste each value into Railway's environment editor.
Do NOT commit, screenshot, or paste into Slack.

```bash
# Two independent random 32-byte secrets (base64-encoded):
openssl rand -base64 32        # → JWT_SECRET
openssl rand -base64 32        # → JWT_REFRESH_SECRET
```

If `openssl` isn't available:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The server fails fast on startup if either still equals the dev defaults
(`dev-secret-change-me-in-production` / `dev-refresh-secret-change-me`)
when `NODE_ENV=production`.

---

## 2. Set every required env var

The full list is in `src/config/env.ts → REQUIRED_FOR_PRODUCTION`. Fast check:

```bash
DATABASE_URL=… JWT_SECRET=… JWT_REFRESH_SECRET=… \
  LEADBYTE_API_KEY=… XERO_CLIENT_ID=… XERO_CLIENT_SECRET=… \
  SIGNNOW_CLIENT_ID=… SIGNNOW_CLIENT_SECRET=… SIGNNOW_USERNAME=… SIGNNOW_PASSWORD=… \
  RESEND_API_KEY=… RESEND_FROM_EMAIL=… CATCHR_ACCESS_TOKEN=… REDIS_URL=… \
  npm run preflight
```

Exits 0 when all 14 required vars are set, 1 with a list of misses otherwise.
Run this in Railway's run-command shell as the last gate before promote.

### Per-integration notes

| Var | Source / gotcha |
|---|---|
| `DATABASE_URL` | Railway Postgres plugin auto-provides this |
| `REDIS_URL` | Railway Redis plugin. **Without it all 3 cron jobs are silently skipped** |
| `XERO_CLIENT_ID` / `_SECRET` | Custom Connection app on `developer.xero.com` (Sam's "Stato" app) |
| `LEADBYTE_API_KEY` | Awaiting Sam (still 🟡 mock mode in 2026-04-22 status) |
| `SIGNNOW_*` | Trial expires ~2026-04-29. Paid plan needed before then |
| `SIGNNOW_BASE_URL` | Default is now `https://api.signnow.com` (production). Override only for sandbox |
| `RESEND_API_KEY` | resend.com → API Keys |
| `RESEND_FROM_EMAIL` | Must match a domain verified in Resend (default `notifications@stato.local` is invalid) |
| `CATCHR_ACCESS_TOKEN` | Obtained via the Catchr MCP OAuth flow |
| `ENDOLE_*` / `CREDITSAFE_*` | Optional. If both unset, credit checks fall back to **mock data** silently — set at least one for prod |
| `R2_*` | Awaiting Sam's Cloudflare card |

---

## 3. Run migrations

```bash
DATABASE_URL=postgresql://… npm run db:migrate
```

Latest migration is `0004_in_memory_to_db.sql` — creates `sops`, `tasks`,
`task_comments`, `task_templates`, `staff`, `job_postings`, `applicants`,
`holiday_requests`; extends `workflows` and `traffic_sources` with extra
columns the rewritten services need.

Idempotent — safe to re-run on a partially migrated DB (`CREATE INDEX IF NOT
EXISTS`, `ADD COLUMN IF NOT EXISTS`).

---

## 4. Seed prod data

```bash
DATABASE_URL=postgresql://… NODE_ENV=production \
  SEED_OWNER_PASSWORD=… SEED_FINANCE_PASSWORD=… SEED_OPS_PASSWORD=… SEED_READONLY_PASSWORD=… \
  npm run db:seed
```

In `NODE_ENV=production` this seeds **only**:
- The `leadgeneration.io` business row (idempotent)
- 4 internal users (owner / finance_admin / ops_manager / readonly)

It does **not** seed Apex Media Ltd or sample notifications. Set
`SEED_DEMO_DATA=true` explicitly if you want them in a staging environment.

If `SEED_*_PASSWORD` env vars are unset, the dev fallback passwords
(`owner123` etc.) are used — fine for staging, **never for prod**.

---

## 5. Deploy + health check

1. Push the release branch to Railway (or trigger the existing GitHub Action).
2. Wait for the deploy to go live.
3. Hit `GET /healthz` → expect `200 { ok: true }`.
4. Hit `GET /api/v1/integrations/status` (auth required) → confirm Xero, Resend,
   SignNow, Endole, Catchr, LeadByte all show `connected: true`.
5. Tail logs for the first 5 minutes:
   - `Workers started` should appear once the worker container boots
   - `Scheduled jobs registered` should appear once
   - LeadByte sync should run within 2 minutes — look for `LeadByte sync complete`

---

## 6. Smoke test as real users

| User | Path | Expected |
|---|---|---|
| `owner@stato.app` | `/dashboard` → `/clients` → `/invoices` | List clients, push one invoice to Xero |
| `client@stato.app` (if seeded) | `/portal` | Sees own client only — never another company's data |

For the portal, the new scope rule is: every query is filtered by
`requester.clientId`. A real client user without `clientId` set on the JWT
will see a 403 on every portal route.

---

## 7. After Sam delivers blockers

- LeadByte API key → set `LEADBYTE_API_KEY` in Railway, redeploy, wait 2 min
  for first sync. Confirm `campaigns` table has rows with non-null
  `leadbyte_campaign_id`.
- Cloudflare card → set `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_ACCOUNT_ID`, `R2_BUCKET`. Test with `POST /api/v1/upload`.
- Resend domain verified → switch `RESEND_FROM_EMAIL` from `onboarding@resend.dev`
  to the verified domain (e.g. `notifications@leadgeneration.io`).
- SignNow paid plan → no env change needed; trial credentials keep working.

---

## Rollback

If preflight passes but production breaks:

```bash
# Railway: revert to previous deploy via dashboard, or:
git revert <bad-commit> && git push origin main
```

The migration is additive (no destructive `DROP` statements), so an old
release served against the new schema won't crash — it just won't see the
new tables.
