# Connect an AI assistant to Stato (MCP)

Stato has a built-in MCP endpoint. An AI assistant that speaks MCP (Cursor, Claude, a Pipeboard bot) can find clients and campaigns, file ad creatives under the right client, record which ad runs which asset, and fetch a download link, all with one API key.

Stato never writes to Meta, Google or TikTok. Your ad-platform tools do that. Stato is the record of which file, copy and landing page runs in which ad, for which client and campaign.

## 1. Make a key

1. Sign in to Stato as the **Owner**.
2. Settings, **API keys**, give the key a name (one key per bot, for example `Cursor - Alex`).
3. Tick only what the bot needs (see the scopes below) and press **Create key**.
4. Copy the key now. It starts with `stk_` and is shown once; Stato stores only a hash.

Revoke it in the same screen. A revoked key stops working within a minute.

## 2. Point the assistant at Stato

- **Endpoint:** `https://<your Stato API host>/mcp` (staging: `https://sato-backend-staging-staging.up.railway.app/mcp`)
- **Auth:** `Authorization: Bearer stk_...` (the header `X-API-Key: stk_...` also works)
- **Transport:** Streamable HTTP, stateless (POST only)
- **Optional:** `X-Stato-Agent: <bot name>` so the Activity screen names the bot

### Cursor

`~/.cursor/mcp.json` (or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "stato": {
      "url": "https://<your Stato API host>/mcp",
      "headers": {
        "Authorization": "Bearer stk_your_key_here",
        "X-Stato-Agent": "Cursor"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport http stato https://<your Stato API host>/mcp \
  --header "Authorization: Bearer stk_your_key_here" \
  --header "X-Stato-Agent: Claude Code"
```

### Any other MCP client

Use the endpoint and headers above. If the client only supports stdio, run it through a Streamable HTTP bridge such as `mcp-remote`.

## 3. Check it works

Ask the assistant to call **`whoami`**. It answers with the key name, the owner, the business, the scopes the key holds and how many calls are left this minute. Then ask it to call **`list_clients`**.

## Scopes

| Scope | Lets the key |
| --- | --- |
| `clients:read` | find clients, find the client that owns an ad account |
| `campaigns:read` | list and read campaigns |
| `ad_accounts:read` | list ad accounts and what they are linked to |
| `ad_accounts:write` | link an ad account to a client (a move needs `confirmMove`) |
| `creatives:read` | list assets, read one, find an asset by an ad ID, list landing pages |
| `creatives:write` | add assets, change details, attach landing pages |
| `creatives:archive` | hide and restore assets (files are never deleted) |
| `uploads:write` | send big files directly to storage |
| `ad_links:write` | record which platform ad runs which asset |
| `landing_pages:write` | save landing pages |

A key with only `*:read` scopes is a read-only key.

## The tools

See [mcp-tools.md](./mcp-tools.md) for all of them with scope and inputs. It is generated from the code, so it is always current.

## The rules the tools enforce

- **Matching is on IDs, never names.** An ad account is `platform` + `accountId`. Meta accounts work with or without `act_`; Google customer IDs with or without dashes. Stato returns the stored form.
- **The ad account decides the client.** If you send an account, the client is the one the account is linked to. An account that is not linked is `account_not_linked`: stop and ask the owner.
- **No silent moves.** Linking an account that belongs to another client is `move_requires_confirm` unless you send `confirmMove: true`.
- **One account can feed several campaigns.** If it does and you send no `campaignId`, the call fails and lists them. Do not guess.
- **No duplicates.** The same file for the same client is one asset (`result: duplicate` with the existing ID). The same ad (platform + `adId`) is one ad link.
- **Nothing is deleted.** Archive hides an asset; the file stays.

## Sending files

| Size | How |
| --- | --- |
| Up to 50 MB, public URL | `upload_asset` with `sourceUrl` |
| 50 MB to 1 GB, public URL | `upload_asset` with `sourceUrl` answers `upload_incomplete` with an `uploadId`. Stato copies the file in the background. Call `complete_upload` with that `uploadId` until `status` is `ready`, then call `upload_asset` again with the `uploadId` |
| Any file you hold, up to 30 MB (images) or 4 GB (videos) | `create_upload` (it says single `uploadUrl` or a list of parts), `PUT` the bytes, `complete_upload`, then `upload_asset` with the `uploadId` |

The file type is read from the first bytes, not the name: an `.exe` renamed `.mp4` is refused. A `sourceUrl` must be a public address; Stato follows up to 3 redirects and checks every hop. Videos get a poster and a duration in the background (`fileStatus` goes from `processing` to `ready`).

`get_asset` returns a signed download link that lasts 60 minutes by default (up to 24 hours with `downloadUrlMinutes`), with the right content type, so Meta or TikTok can fetch it through your ad-platform tool.

## Errors

A tool error comes back with `isError: true` and a body:

```json
{ "status": "error", "code": "account_not_linked", "message": "The meta account 123 is not linked to a client.",
  "hint": "Link it first with link_ad_account, or ask the owner which client it belongs to.",
  "fields": [], "retryable": false, "requestId": "..." }
```

Codes: `unauthorized`, `insufficient_scope`, `not_found`, `validation_failed`, `account_not_linked`, `account_client_mismatch`, `campaign_client_mismatch`, `move_requires_confirm`, `duplicate`, `file_too_large`, `unsupported_type`, `source_unreachable`, `upload_incomplete`, `rate_limited`, `internal_error`. Read `hint`: it says what to do next. `retryable: true` means repeating the same call can work.

## Limits

- 120 calls a minute per key. Over that: `rate_limited` with `retryAfter` seconds. Bytes sent straight to storage do not count.
- Write tools take an optional `idempotencyKey` (24 hours). Repeating the same call with the same key returns the first answer; the same key with different arguments is refused.
- Every call is written to Settings, API keys, **Activity**: the bot name, the tool, the arguments (secrets and file bytes removed), the result and the records it touched. Rows are kept for 12 months.

## Troubleshooting

| You see | Do this |
| --- | --- |
| 401 or `unauthorized` | the key is wrong, expired or revoked; make a new one |
| `insufficient_scope` | add the scope named in the message to the key |
| `rate_limited` | wait `retryAfter` seconds and repeat the same call |
| the client says the tool output does not match the schema | update Stato to the latest staging build; older builds could not return errors to SDK clients |
| `upload_incomplete` on `upload_asset` | normal for a big `sourceUrl`: poll `complete_upload` with `details.uploadId` |
