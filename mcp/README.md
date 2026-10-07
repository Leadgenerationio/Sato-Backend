# Stato MCP server

> **Superseded.** Stato now serves MCP itself at `/mcp` (22 tools, Streamable HTTP, the same API keys). Use that: see [docs/mcp-setup.md](../docs/mcp-setup.md) and [docs/mcp-tools.md](../docs/mcp-tools.md). This folder is the older stdio wrapper over the REST API and is kept only for clients that cannot use HTTP.

This lets an AI assistant (Claude Desktop, Claude Code, or any MCP client) file Meta and Taboola creatives under the right client in Stato. It is phase 4 of `docs/creative-library-and-api-plan.md`: a thin wrapper over the Stato public API.

The server adds no rights of its own. Every call uses **your Stato API key**, so the assistant can do exactly what that key's scopes allow and nothing more.

| Tool | What it does | REST call | Scope |
| --- | --- | --- | --- |
| `find_client_by_ad_account` | Which client owns this ad account? | `GET /api/v1/clients/lookup?platform=&accountId=` | `clients:read` |
| `link_ad_account` | Record that an ad account belongs to a client | `POST /api/v1/clients/{id}/ad-accounts` | `ad_accounts:write` |
| `upload_creative` | File an image/video (by public URL) under the client | `POST /api/v1/creatives` + `Idempotency-Key` | `creatives:write` |
| `list_creatives` | Search creatives | `GET /api/v1/creatives` | `creatives:read` |
| `attach_landing_page` | Set a creative's landing page | `POST /api/v1/creatives/{id}/landing-page` | `landing_pages:write` |

Ad accounts are matched on **platform + account ID**, never on the account name. Some Taboola accounts are named after a different campaign.

`upload_creative` is safe to retry. It sends an `Idempotency-Key` built from the platform's creative ID, or from a hash of the request when there is no creative ID, so the same creative sent twice is updated rather than copied. You can also pass your own `idempotencyKey`.

> **Needs the public API.** These tools call the X-API-Key endpoints from the plan's phase 2 (API keys and creatives), which ship in their own PR. Until those are deployed, every tool returns "The Stato API key is missing, wrong or revoked".

## Run it locally (stdio)

```bash
cd mcp
npm ci
npm run build
STATO_API_URL=https://sato-backend-production.up.railway.app STATO_API_KEY=stk_… node dist/stdio.js
```

**Claude Code:**

```bash
claude mcp add stato --env STATO_API_URL=https://sato-backend-production.up.railway.app --env STATO_API_KEY=stk_… -- node /path/to/Sato-Backend/mcp/dist/stdio.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "stato": {
      "command": "node",
      "args": ["/path/to/Sato-Backend/mcp/dist/stdio.js"],
      "env": { "STATO_API_URL": "https://sato-backend-production.up.railway.app", "STATO_API_KEY": "stk_…" }
    }
  }
}
```

## Host it (Streamable HTTP)

```bash
STATO_API_URL=https://sato-backend-production.up.railway.app PORT=3010 node dist/http.js
# POST /mcp   (stateless Streamable HTTP, JSON responses)
# GET  /health
```

- **One deployment, many keys.** Each caller sends its own key as `Authorization: Bearer <stato api key>` (or `X-API-Key`). The server passes it through to Stato per request and keeps no state between callers. Leave `STATO_API_KEY` unset when hosting; it is only a fallback for a single-user deployment.
- **Allowed hosts.** Set `MCP_ALLOWED_HOSTS=mcp.stato.tech` (a comma-separated list) to refuse requests whose `Host` header is anything else.

**Claude Code against the hosted server:**

```bash
claude mcp add --transport http stato https://mcp.stato.tech/mcp --header "Authorization: Bearer stk_…"
```

### Deploying next to the backend on Railway

Add a second service to the same Railway project from this repo:

- **Root directory:** `mcp`
- **Builder:** Dockerfile. `mcp/Dockerfile` builds and runs `dist/http.js` on `$PORT`.
- **Variables:**
  - `STATO_API_URL`: the backend's private URL, e.g. `http://sato-backend.railway.internal:3001`, or its public URL.
  - `MCP_ALLOWED_HOSTS`: the public domain you give this service.
- **Health check path:** `/health`

The backend's own build, typecheck and tests don't include `mcp/`. It has its own `package.json` and lockfile (npm, kept separate from the backend's pnpm workspace), so a change here can't break the API deploy.

## Develop

```bash
npm ci
npm test          # vitest against a fake Stato API: request shapes, headers, errors
npm run typecheck
```
