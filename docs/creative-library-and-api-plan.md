# Creative library, landing pages, and the public API / MCP: plan

Reply to Sam's feedback round 1 (29 Sep 2026), item **M2** and **section 5**.
Status: **proposal**. The phases and effort estimates are Octogle's to confirm
before we commit to dates.

## What exists today (checked in the code, not only on screen)

| Piece | Where | State |
| --- | --- | --- |
| `creatives` table | `src/db/schema/creatives.ts` | Keyed to **campaign** only. Stores name, R2 key, size, content type, section (`media` / `copy_lp`), approval status. No client, platform, ad ID, landing page, dimensions or hash. |
| Buyer approvals | `creative_approvals` | Append-only audit log per creative (IP, user agent, timestamp). Each buyer on a campaign approves **their own copy** in the portal. **Any redesign has to keep this.** |
| `landing_pages` table | `src/db/schema/landing-pages.ts` | Already exists (migration 0000) but **nothing reads or writes it**. Keyed to campaign, not client. |
| Ad account links | `traffic_sources` (`accountId` + `accountIds[]`) | Keyed to **campaign**. This is the "Ad Account Links" card. |
| Campaign ↔ client | `client_campaigns` | **Many-to-many.** One campaign (a vertical) serves several buyers. |
| Auth | `src/middleware/auth.middleware.ts` | JWT bearer only. No API keys, no scopes, no OpenAPI. |
| Catchr | `src/integrations/catchr/` | Spend and leads only. Catchr has **no creative-level data**, so it can't be the creative source. |
| R2 folders | `r2-types.ts` | `creatives` and `landing-pages` folders already exist. |

**Key finding for Sam's spec.** "Ad account → campaign → client" can't
name a single client today. A campaign has several buyers, so a Meta
account linked to "Hearing Aids (CH)" could belong to any of them. The
`client_ad_accounts` table in the spec is therefore **necessary**, not
optional. It is the only record that says whose ad account it is.

## Design decisions (please confirm)

1. **A creative belongs to a client, and optionally to a campaign.** Add
   `client_id` (nullable during backfill) next to the existing `campaign_id`.
   Existing campaign-shared creatives keep working in the portal approval
   flow. New creatives synced from Meta or Taboola are filed under the
   client that owns the ad account.
2. **Landing pages become per-client records.** Rework the unused
   `landing_pages` table rather than add a second one: add `client_id`,
   `title` and `screenshot_key`, make `campaign_id` nullable, and add
   `UNIQUE(client_id, normalised_url)`. The URL is normalised (lower-case
   host, tracking params such as `utm_*`, `fbclid` and `gclid` stripped) so
   the same page arriving from two ads becomes one record.
3. **Match on IDs, never names.** Some Taboola account names don't match
   their IDs (for example the ID "…willwriting-sc" is named "Hearing Aids
   Poland"). The unique key is `(platform, account_id)`.
4. **Deduplication.** `UNIQUE(platform, platform_creative_id)` where present,
   and SHA-256 of the file for manual uploads. Sending the same creative
   twice updates it; `Idempotency-Key` makes a retried POST return the
   first result.

## Data model (phase 1)

```sql
CREATE TABLE client_ad_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  platform     varchar(20) NOT NULL,          -- meta | taboola | google | tiktok
  account_id   varchar(100) NOT NULL,
  account_name varchar(255),                  -- display only, never matched on
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  campaign_id  uuid NULL REFERENCES campaigns(id) ON DELETE SET NULL,
  currency     varchar(3),
  created_at   timestamptz DEFAULT now(),
  UNIQUE (platform, account_id)
);

ALTER TABLE creatives
  ADD COLUMN client_id            uuid REFERENCES clients(id),
  ADD COLUMN platform             varchar(20),
  ADD COLUMN platform_ad_id       varchar(100),
  ADD COLUMN platform_creative_id varchar(100),
  ADD COLUMN platform_campaign_id varchar(100),
  ADD COLUMN platform_campaign_name varchar(255),
  ADD COLUMN landing_page_id      uuid REFERENCES landing_pages(id),
  ADD COLUMN headline text, ADD COLUMN body_text text,
  ADD COLUMN width int, ADD COLUMN height int, ADD COLUMN duration_s numeric(8,2),
  ADD COLUMN sha256 char(64),
  ADD COLUMN thumbnail_key varchar(500),
  ADD COLUMN first_seen timestamptz, ADD COLUMN last_seen timestamptz,
  ALTER COLUMN campaign_id DROP NOT NULL;
CREATE UNIQUE INDEX creatives_platform_creative_uq
  ON creatives (platform, platform_creative_id) WHERE platform_creative_id IS NOT NULL;

ALTER TABLE landing_pages
  ADD COLUMN client_id uuid REFERENCES clients(id),
  ADD COLUMN normalised_url varchar(500),
  ADD COLUMN title varchar(255),
  ADD COLUMN screenshot_key varchar(500),
  ALTER COLUMN campaign_id DROP NOT NULL;
CREATE UNIQUE INDEX landing_pages_client_url_uq ON landing_pages (client_id, normalised_url);

CREATE TABLE api_keys (id uuid PK, business_id uuid, name varchar(100), prefix char(8),
  hash char(64) UNIQUE, scopes text[], created_by uuid, last_used_at timestamptz,
  revoked_at timestamptz, created_at timestamptz);
CREATE TABLE api_key_usage (id bigserial PK, api_key_id uuid, method varchar(8),
  path varchar(300), status int, at timestamptz DEFAULT now());
CREATE TABLE idempotency_keys (key varchar(100), api_key_id uuid, response jsonb,
  created_at timestamptz, PRIMARY KEY (api_key_id, key));   -- 24 h TTL
CREATE TABLE webhook_endpoints (id uuid PK, business_id uuid, url varchar(500),
  secret_hash char(64), events text[], active boolean, created_at timestamptz);
CREATE TABLE webhook_deliveries (id bigserial PK, endpoint_id uuid, event varchar(50),
  payload jsonb, status int, attempts int, next_attempt_at timestamptz);
```

Backfill: `creatives.client_id` is set where the campaign has exactly one
buyer. Campaigns with several buyers stay shared (`client_id` NULL, shown
under every buyer as "Shared on <campaign>"). The ~3 existing creatives are
checked by hand.

## Phases

### Phase 1: mapping, data model and screens (the M2 fix). About 2 weeks.
- Migrations above (creatives, landing pages, client_ad_accounts).
- **Bulk "Link ad accounts" screen (S13).** Lists every Catchr account (Meta,
  Google, TikTok, Taboola) with spend over the last 30 days. For each one,
  pick a client and an optional campaign, many rows at a time. Unlinked
  spend is shown first, so the £586k in unlinked spend is visible.
- **Creatives library** at `/creatives`, plus a **Creatives tab on each
  client**:
  - thumbnail grid for images, poster frame and inline player for video;
  - multi-file drag-and-drop;
  - filters for client, platform, campaign, landing page, date and status;
  - search and sort;
  - bulk actions: assign landing page, move to client, submit for approval.
- **Landing pages** at `/landing-pages` and a tab on each client: URL as its
  own record, the creatives that point to it, and a screenshot when one is
  available.
- Upload hardening (S9) on the same pipeline: image and video only, a size
  cap, and the SHA-256 worked out in the browser before upload.
- The existing campaign "Creatives" card and the portal approval flow keep
  working unchanged.

### Phase 2: API keys, endpoints and docs. About 1–1.5 weeks.
- **Settings → API keys.** Create, name, choose scopes (`clients:read`,
  `ad_accounts:write`, `creatives:write`, `creatives:read`,
  `landing_pages:write`) and revoke. The key is shown once, and only its
  SHA-256 is stored. `X-API-Key` header. Every call is logged in
  `api_key_usage` and shown per key.
- An `apiKeyOrJwt` middleware sits alongside `authMiddleware`. Scope checks
  and rate limits (per key, `express-rate-limit`) apply.
- Endpoints (under `/api/v1`):
  - `GET  /clients/lookup?platform=&accountId=`
  - `POST /clients/{id}/ad-accounts`
  - `POST /creatives` with `Idempotency-Key`. Accepts `sourceUrl` (the
    server fetches the file, checks the type and hashes it) **or** the
    existing presign flow.
  - `GET  /creatives?clientId&platform&campaignId&landingPage&q&sort&page`
  - `POST /landing-pages`, `POST /creatives/{id}/landing-page`
  - `GET  /openapi.json` plus a docs page, generated from the zod schemas
    already on every route (`zod-to-openapi`), so the docs can't drift from
    the validators.
- Server-made thumbnails: `sharp` for images, `ffmpeg` poster frame for
  video, run as a BullMQ job (the worker exists already).

### Phase 3: scheduled pull from Meta and Taboola. About 1.5–2 weeks after credentials arrive.
- **Meta:** `GET /act_{id}/ads?fields=id,name,adset{id,name},campaign{id,name},creative{id,image_url,video_id,thumbnail_url,object_story_spec,asset_feed_spec}`,
  paged, with `effective_status` filtered to active and recently active.
  Video source is fetched from `/{video_id}?fields=source,length`.
- **Taboola Backstage:** campaigns, then `/campaigns/{id}/items` for each
  linked account (`url`, `thumbnail_url`, `title`, `description`).
- A BullMQ repeatable job every 3 h (configurable) for each linked account.
  It upserts on `(platform, platform_creative_id)`, updates `last_seen`,
  creates or links the landing page from the ad's destination URL, and
  stores the media in R2. It never stores expiring CDN links, which also
  fixes nice-to-have #8. Per-account errors appear on the "Link ad
  accounts" screen.
- **Needs from Sam (this is the blocker):**
  - a Meta **system user token** with `ads_read` on every ad account, from
    the Business Manager that owns them;
  - Taboola Backstage API **client ID and secret** with access to each
    advertiser account.

### Phase 4: webhooks and MCP. About 1 week.
- **Settings → Webhooks.** Events are `creative.added`, `creative.changed`
  and `client.added`. Each request carries an HMAC-SHA256 signature
  (`X-Stato-Signature: t=…,v1=…`). Retries back off and delivery history is
  shown.
- **MCP server:** a thin wrapper over the phase 2 API, authenticated with an
  API key and deployed next to the backend (streamable HTTP). Tools:
  `find_client_by_ad_account`, `link_ad_account`, `upload_creative`,
  `list_creatives` and `attach_landing_page`. Each tool reuses the REST
  endpoint's scopes, so the MCP can do exactly what its key allows.

## Timeline (proposed, to be confirmed by Octogle)

| Phase | Effort | Depends on |
| --- | --- | --- |
| Round 1 must-fix items (M1, M3–M7) | in review now | — |
| 1. Mapping + creatives + landing pages + screens | ~2 weeks | Sam confirms the design decisions above |
| 2. API keys + endpoints + OpenAPI | ~1–1.5 weeks | Phase 1 |
| 3. Meta / Taboola scheduled pull | ~1.5–2 weeks | Phase 2 **and** Meta + Taboola credentials |
| 4. Webhooks + MCP | ~1 week | Phase 2 (can run alongside phase 3) |

About 6–7 weeks in total, and phase 3 can't start until the credentials
arrive. Each phase is deployed and handed to Sam to retest on phone and
desktop before the next phase is called done.

## Questions for Sam
1. Should a creative that runs for several buyers on the same vertical show
   under each buyer, or be filed under just one? (This decides the backfill
   and the portal view.)
2. Which platforms are needed on day one of phase 3: only Meta and Taboola,
   or Google and TikTok as well?
3. Who should be able to create API keys? We suggest Owner only.
