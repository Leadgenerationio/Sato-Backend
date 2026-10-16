# MCP acceptance harness

`scripts/mcp-acceptance.ts` replays Sam Wynne's 16 MCP acceptance tests, plus test 17 for the fixes from his 15 Oct staging run (null optional inputs, `retryable` on URL errors, campaigns on `list_ad_accounts`, `thumbnailStatus`, Activity without connection steps), against a running Stato backend, the way a bot sees it: the official MCP SDK client (`@modelcontextprotocol/sdk`, Streamable HTTP) at `<base>/mcp` with a Stato API key, and the Owner's REST screens as the reference to compare against. Every check is reported as PASS, FAIL or BLOCKED with what was actually observed, so the run can be repeated by anyone and compared run to run.

## Run it

```sh
STATO_BASE_URL=https://sato-backend-staging-staging.up.railway.app \
STATO_EMAIL=<owner email> STATO_PASSWORD=<owner password> \
pnpm mcp:acceptance
```

Only some tests: `TESTS=3,5,7,8,10,11,12 pnpm mcp:acceptance`.

| Variable | Needed | What it does |
| --- | --- | --- |
| `STATO_BASE_URL` | yes | Backend origin, without `/api/v1`. |
| `STATO_EMAIL`, `STATO_PASSWORD` | yes | An **Owner** login (API keys, Activity and webhooks are Owner only). Read from the environment only; never printed or written to the results. |
| `TESTS` | no | Comma list of test numbers. Default: all 17. |
| `OUT` | no | Results folder. Default `./acceptance-out/<run tag>/` (gitignored). |
| `STATO_CAMPAIGN_ID` | no | Stato campaign UUID for test 3. Default: the seeded "MCP TEST" campaign (`MCPTEST-1`, see `scripts/seed-staging-mcp-campaigns.ts`). |
| `WEBHOOK_URL` | no | Receiver for the `creative.added` check. Default `https://httpbin.org/status/200`. |
| `SAMPLE_MP4` | no | A real short mp4, used when `ffmpeg` is not installed. |
| `VIDEO_MB` | no | Size of the test-3 video. Default 300. |
| `CLEANUP=1` | no | Also delete the run's two clients at the end. By default they are kept as evidence. |
| `ALLOW_HOST` | no | See the guard below. |

**Production guard.** The harness writes data, so it refuses to start unless the host contains `staging` or is `localhost` / `127.0.0.1`. To point it anywhere else you must set `ALLOW_HOST` to exactly that host. Never point it at production.

## What it creates, and what it cleans up

Each run has a tag (the last 9 digits of the start time). Everything is named so it is obvious who made it:

- Clients `Yash Test <date> ACC <tag> Client A` and `… Client B` (no contact email, so no welcome email is sent).
- Fake but well-formed ad accounts: Meta `act_8<tag>0001` (A, feeds the campaign), `act_8<tag>0002` and `act_8<tag>0003` (B; test 7 moves the second to A), `act_8<tag>0009` (never linked); TikTok `7<tag>000000019` (19 digits) and a Google ID `5xx-xxx-xxxx`, both on A.
- 18-digit Meta campaign/ad set/ad/creative/video IDs `120<tag>00000N` for the ad links.
- A buyer link from client A to the test campaign.
- A webhook endpoint subscribed to `creative.added`.
- API keys `Yash Test ACC <tag> main` (all scopes), `… readonly`, `… ratelimit`.
- Assets (the big video, small PNGs) and one landing page on client A.

At the end, in a `finally`, it **revokes every key it created**, **deletes the webhook endpoint**, and **removes the campaign link**. The clients and their assets stay (unless `CLEANUP=1`); everything created is listed by id in `results.json` / `results.md` under "Data created".

## The video for test 3

The server reads a video's duration and makes its poster itself (ffprobe/ffmpeg on the server). The harness only needs a real mp4 to send:

1. `ffmpeg` installed: it generates a 12-second 640x360 test pattern.
2. Otherwise `SAMPLE_MP4=/path/to/short.mp4`.
3. Otherwise a synthetic file the server accepts as mp4 but cannot read: the size, type, SHA-256 and filing checks still run, and the duration and poster checks are reported BLOCKED with that reason.

The file is padded to `VIDEO_MB` with an mp4 `free` box (still a valid file, unique per run), sent with `create_upload` (multipart), each part PUT straight to its presigned URL, then `complete_upload` (polled while the server hashes it) and `upload_asset`.

## Output

`results.json` has, per test, every check with `id`, `name`, `verdict`, `observed` and `ms`, plus the data created and the clean-up done. `results.md` is the same as tables. The console ends with `N passed, N partial, N failed, N blocked`:

- **passed**: every check passed.
- **partial**: no check failed, but some were BLOCKED.
- **failed**: at least one check failed.
- **blocked**: nothing could be checked.

Anything shaped like an API key (`stk_…`) or a login token is redacted from every observed string and from both files. The exit code is 1 when a test failed or set-up failed.

## Checks that are BLOCKED by design

- **2**: list_campaigns vs the Campaigns screen. That screen is sourced from LeadByte, which is in mock mode on staging.
- **3**: duration and poster, when no real mp4 was available (see above).
- **9**: Sam's bot creating the Meta ad from the download URL through Pipeboard. The harness never writes to an ad platform.

## Running it against a local backend

1. Bring the local database up to date: `pnpm db:auto-migrate`.
2. Give it S3-compatible storage for uploads. Point `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` at it, for example the MinIO in `docker-compose.test.yml` or any S3 emulator.
3. Seed the test campaign: `npx tsx scripts/seed-staging-mcp-campaigns.ts --confirm-staging --host=localhost --dummy-client`.
4. Start the API on `PORT=3001` with the third-party keys (LeadByte, Xero, Resend, Catchr and the rest) blanked, so nothing remote is called.
5. Run: `STATO_BASE_URL=http://localhost:3001 STATO_EMAIL=owner@stato.app STATO_PASSWORD=owner123 pnpm mcp:acceptance`.

Without Redis, the background video processing does not run locally, so a real video stays `processing` and its duration/poster checks fail there. That is the local environment, not the code under test.
