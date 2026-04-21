# Test Sandbox Setup

Run integrations end-to-end **without Sam's real credentials**. Three pieces:

1. **MinIO** — stands in for Cloudflare R2 (S3-compatible, local)
2. **DocuSign Developer Sandbox** — free, envelope signing works end-to-end
3. **LeadByte mock server** — local Express stub for when real API docs aren't wired yet

---

## 1. Prerequisites

- Docker Desktop running (Windows: start from the system tray)
- Node 20+, pnpm 10+
- An email you control (for DocuSign signature testing)

---

## 2. Bring up local sandboxes

```bash
cd Sato-Backend
docker compose -f docker-compose.test.yml up -d
```

This starts:

| Service  | Port | Purpose |
|----------|------|---------|
| Postgres | 5432 | Test DB |
| Redis    | 6379 | BullMQ queue |
| MinIO    | 9000 | S3-compatible storage (R2 stand-in) |
| MinIO UI | 9001 | Browse files at http://localhost:9001 |

MinIO UI login: `stato-test-key` / `stato-test-secret`
Bucket `stato-test` is auto-created.

Tear down: `docker compose -f docker-compose.test.yml down -v`

---

## 3. Copy env file

```bash
cp .env.test.example .env.test
```

This file is safe to commit? **No** — `.env.test` is gitignored. Only `.env.test.example` lives in git.

---

## 4. DocuSign Developer Sandbox (free)

### 4.1 Create account
1. Go to https://developers.docusign.com → **Create Sandbox**
2. Verify the email → log in at https://appdemo.docusign.com

### 4.2 Create app for JWT auth
1. Settings → **Apps and Keys** → **Add App and Integration Key**
2. Name: `Stato Local`
3. Authentication: **JWT Grant** — generate RSA keypair, download private key
4. Redirect URI: `http://localhost:3001/api/v1/integrations/docusign/callback`
5. Copy values into `.env.test`:
   - `DOCUSIGN_INTEGRATION_KEY` = Integration Key
   - `DOCUSIGN_SECRET` = Secret Key
   - `DOCUSIGN_USER_ID` = API Username (GUID)
   - `DOCUSIGN_ACCOUNT_ID` = API Account ID (top-right of dashboard)

### 4.3 Grant consent (one-time)
Visit this URL in browser, signed in as your sandbox user:
```
https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=YOUR_INTEGRATION_KEY&redirect_uri=http://localhost:3001/api/v1/integrations/docusign/callback
```
Approve. You only do this once per sandbox user.

### 4.4 Test
Send a test envelope to yourself:
```bash
curl -X POST http://localhost:3001/api/v1/agreements/test-envelope \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"signerEmail":"you@example.com","signerName":"You"}'
```
- Email arrives within seconds
- Click signing link → sign
- Webhook hits your local endpoint (use `ngrok http 3001` to expose it publicly, then set the ngrok URL as the Connect webhook in DocuSign admin)
- Signed PDF uploads to MinIO bucket `stato-test` — browse at http://localhost:9001

---

## 5. MinIO / R2 smoke test

```bash
# Upload a test file via AWS CLI (R2 uses the same protocol)
aws --endpoint-url http://localhost:9000 \
    --region auto \
    s3 cp README.md s3://stato-test/smoke.md

# Verify
aws --endpoint-url http://localhost:9000 s3 ls s3://stato-test
```

Swap AWS CLI credentials env vars with the MinIO ones:
```bash
export AWS_ACCESS_KEY_ID=stato-test-key
export AWS_SECRET_ACCESS_KEY=stato-test-secret
```

When Sam provides real R2 credentials, only these change:
- `R2_ENDPOINT` → `https://<account-id>.r2.cloudflarestorage.com`
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` → real values
- App code stays identical (R2 is S3-wire-compatible).

---

## 6. LeadByte local mock (optional, until real docs wired)

Until the real LeadByte client is built (Task #1), keep `LEADBYTE_API_KEY` empty — the existing client returns mock data.

If you want to simulate real HTTP responses, run a tiny Express stub:
```bash
npx json-server --watch leadbyte-fixtures.json --port 8888
```
Point `LEADBYTE_BASE_URL=http://localhost:8888` and craft `leadbyte-fixtures.json` with sample payloads from the docs Sam shared.

---

## 7. Running the test suite

```bash
pnpm test                  # full suite with mocks
pnpm test:integration      # add this script to run against docker-compose.test.yml
```

Integration-test script to add to `package.json`:
```json
"test:integration": "dotenv -e .env.test -- vitest run src/__tests__/integration"
```

---

## 8. Production handoff

When Sam sends real credentials:

| Sandbox | Swap to | Change |
|---|---|---|
| MinIO | Cloudflare R2 | `R2_ENDPOINT`, keys, bucket name |
| DocuSign demo | DocuSign production | `DOCUSIGN_BASE_PATH` → `www.docusign.net/restapi`, new Integration Key |
| Postgres local | Railway | `DATABASE_URL` from Railway dashboard |
| Redis local | Railway / Upstash | `REDIS_URL` |

No code changes needed — only `.env` swaps.

---

## 9. Troubleshooting

**Docker daemon not running** — open Docker Desktop, wait for the whale icon to stop pulsing.

**Port conflict on 5432/6379/9000** — check if you have Postgres/Redis already running locally: `lsof -i :5432` (use `netstat -ano | findstr :5432` on Windows). Stop the host service or change the port mapping in `docker-compose.test.yml`.

**MinIO "bucket not found"** — the `minio-init` container creates it on first boot. If it failed, rerun: `docker compose -f docker-compose.test.yml up minio-init`.

**DocuSign webhook not firing locally** — DocuSign can't reach `localhost`. Use `ngrok http 3001` and paste the ngrok URL into DocuSign Admin → Connect.
