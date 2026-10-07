# Give Lively → Meta Conversions API (Cloudflare Worker)

Give Lively hosts its own checkout, so you can't put a Meta Pixel on it. This Worker
closes that gap: every few minutes it polls Give Lively's JSON feed (the same one that
powers its Zapier integration), picks out paid **ticket sales for one event**, and sends
each one to Meta as a server-side **Purchase** event. Facebook and Instagram campaigns can
then optimize for, and report on, real ticket sales.

It replaces a Zapier Zap. It runs on the Cloudflare Workers free plan with a free D1
database, has no runtime dependencies, and you can set it up and run it entirely from a
phone using the Cloudflare dashboard.

- Plain donations and other events are ignored.
- Each sale is sent exactly once, even when Give Lively shows the record again after an update.
- Email, name and phone are SHA-256 hashed before they leave the Worker. Raw PII is never stored or logged.
- No secrets live in this repo. You enter them once in the Cloudflare dashboard.

## How it works

```
Cron (every 5 min) ─► fetch Give Lively feed since last run (minus 10 min overlap)
                   ─► keep paid tickets for EVENT_MATCH       (src/filter.ts)
                   ─► drop IDs already sent                   (D1)
                   ─► map + hash into Meta events             (src/map.ts)
                   ─► one batched POST to Meta CAPI           (src/meta.ts)
                   ─► save sent IDs, advance cursor on success
```

If Meta or Give Lively fails, nothing is marked sent and the next run retries.

## Setup

You only do this once. Every later change is a GitHub commit, and Workers Builds deploys it.

### 1. Fork or copy this repo

If you're adapting this for your own organization, fork it. Nothing in it is specific
to one organization; your details all go into the dashboard.

### 2. Get your keys

| What | Where |
|---|---|
| **Give Lively org ID and API key** | Give Lively Nonprofit Admin Portal → Integrations → Zapier → create an API key. The portal shows both values. |
| **Meta Pixel (dataset) ID** | Meta Events Manager → Data sources → your pixel → the ID under its name. |
| **Meta access token** | Events Manager → your pixel → Settings → Conversions API → *Generate access token*. |
| **Admin token** | Any long random string. Generate one in your password manager and save it there. |

### 3. Connect the repo in Workers Builds

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**.
2. Pick this GitHub repo.
3. **Project name: `givelively-capi`**. It must match `"name"` in `wrangler.jsonc`.
4. Leave the build command empty. Keep the deploy command `npx wrangler deploy`.
5. **Save and Deploy**.

The first deploy creates the D1 database automatically. You don't need to create it
yourself or paste an ID anywhere (see [Troubleshooting](#troubleshooting) if it fails).

### 4. Add variables and secrets

Worker → **Settings** → **Variables and Secrets** → **Add**. Each one is entered once and
kept across deploys.

**Secrets** (choose type *Secret*):

| Name | Value |
|---|---|
| `GL_API_KEY` | Give Lively Zapier API key |
| `META_ACCESS_TOKEN` | Meta Conversions API token |
| `ADMIN_TOKEN` | Your admin token |

**Variables** (type *Text*):

| Name | Value | Needed for |
|---|---|---|
| `GL_ORG_ID` | Give Lively org ID | Phase 1 |
| `EVENT_MATCH` | Text that identifies your event, e.g. `Art Soup 2026` (case-insensitive) | Phase 2 |
| `EVENT_PAGE_URL` | Public ticket page URL | Phase 2 |
| `META_PIXEL_ID` | Pixel/dataset ID | Phase 2 |
| `META_TEST_EVENT_CODE` | From Events Manager → Test events. Delete it to go live. | Testing |
| `SEND_TO_META` | `true` to start sending. Leave it unset until testing. | Phase 2 |

Optional: `CURRENCY` (default `USD`), `META_ACTION_SOURCE` (default `website`, see
[Troubleshooting](#troubleshooting)).

These live in the dashboard, not the repo, because `wrangler.jsonc` sets
`"keep_vars": true`. The repo only holds generic defaults (`META_API_VERSION`,
`OVERLAP_MS`, `BACKFILL_HOURS`). A variable defined in `wrangler.jsonc` overrides the
dashboard value on every deploy, so change those three by editing the file.

### 5. Open the admin console

Visit `https://givelively-capi.<your-subdomain>.workers.dev/` on your phone. Paste your
admin token once; the page remembers it in that browser only. Buttons:

- **Status**: last run, cursor, counts, the last 10 event IDs, and any missing settings.
- **Dry run**: shows what the next poll would send, with no sending or saving.
- **Run now**: runs one real poll (when `SEND_TO_META` is `true`).
- **Sample schema**: field names and types from the Give Lively feed. No values.

The page itself holds no data. Every endpoint needs `Authorization: Bearer <ADMIN_TOKEN>`.

## Phase 1: discover the feed's fields

Give Lively doesn't document the feed's field names, or how tickets look in it. So
before anything is sent to Meta:

1. Buy one test ticket on the event page, and make one small plain donation.
2. In the console, tap **Sample schema** (window: 24 hours).
3. Look at `shapes` (records grouped by their set of fields) and `schema` (every field
   path, its type, how many records have it, and what its strings look like).
4. To see values for fields that aren't personal, such as status or line-item type,
   enter them in *Show values for fields*, e.g. `status, line_item_type, event_name`.
   Personal fields (email, names, address, phone, notes...) are always blocked, and
   anything that looks like an email or phone number is hidden.
5. If `EVENT_MATCH` is set, `current_filter` shows how today's filter classifies each record.

## Phase 2: point the filter at the real fields

Edit `src/fields.ts` so the real field names come first in each list (ID, time,
email, amount, status, ticket type, event name...). Adjust `src/filter.ts` if tickets
need a different rule. Commit, and Workers Builds redeploys.

Then **Dry run** in the console. Your test ticket should appear as `would_send` with
the right value, and the donation should be absent.

## Test with Meta Test Events, then go live

1. Set `META_TEST_EVENT_CODE` and `SEND_TO_META=true` in the dashboard.
2. Buy a low-cost test ticket (complimentary tickets are excluded on purpose).
3. Tap **Run now**. In Events Manager → **Test events**, confirm a Purchase with the
   right value and matched customer info.
4. Tap **Run now** again. Confirm no duplicate.
5. Make a plain donation and run again. Confirm nothing is sent.
6. Delete `META_TEST_EVENT_CODE`. You're live, and the cron sends new sales every 5 minutes.

`BACKFILL_HOURS` (default `0`) controls how far back the very first run looks.
Leave it at `0` so launching doesn't flood Meta with old sales. Meta rejects
events older than 7 days in any case, so this Worker skips them.

## Settings reference

| Name | Kind | Default | Purpose |
|---|---|---|---|
| `GL_ORG_ID` | dashboard var | | Give Lively organization ID |
| `GL_API_KEY` | secret | | Give Lively Zapier API key (part of the feed URL, never logged) |
| `META_PIXEL_ID` | dashboard var | | Pixel/dataset ID |
| `META_ACCESS_TOKEN` | secret | | Conversions API token (sent in the request body, never logged) |
| `META_API_VERSION` | `wrangler.jsonc` | `v26.0` | Graph API version |
| `META_TEST_EVENT_CODE` | dashboard var | | Send to Test Events instead of production |
| `META_ACTION_SOURCE` | dashboard var | `website` | Meta `action_source` |
| `EVENT_MATCH` | dashboard var | | Case-insensitive substring identifying the event |
| `EVENT_PAGE_URL` | dashboard var | | Sent as `event_source_url` |
| `CURRENCY` | dashboard var | `USD` | Purchase currency |
| `SEND_TO_META` | dashboard var | off | `true` enables sending |
| `OVERLAP_MS` | `wrangler.jsonc` | `600000` | Re-read window to catch late records |
| `BACKFILL_HOURS` | `wrangler.jsonc` | `0` | First-run look-back |
| `ADMIN_TOKEN` | secret | | Bearer token for `/status`, `/run`, `/sample` |
| `DB` | D1 binding | auto | Dedupe, cursor, run history |

The poll interval is `triggers.crons` in `wrangler.jsonc` (default every 5 minutes).

## Failure handling

- **Give Lively down / 404**: logged without the URL; nothing changes; retried next run.
- **Meta outage, rate limit, bad token or pixel ID**: nothing is marked sent and the
  cursor stays put. Events are never rejected for configuration problems.
- **Meta rejects the batch**: events are retried one by one. Accepted ones are saved
  as `sent`, invalid ones as `rejected`. If nothing in the run succeeds, an event is
  given up on only after 5 runs in a row.
- **Ticket record that can't be mapped** (no email, too old, no timestamp): saved
  once as `skipped` with a reason code, never retried.
- **Pending payments** aren't recorded, so a sale sends once its status turns paid.
- Overlapping runs (cron plus **Run now**) are prevented with a short D1 lock.

## Troubleshooting

**First deploy fails creating the D1 database.** Automatic provisioning needs Wrangler
4.45+ (the repo pins it). If it still fails, create a database in the dashboard
(Storage & Databases → D1 → Create, name `givelively-capi`) and add its ID to
`wrangler.jsonc` as `"database_id"`. The ID isn't a credential, but it's specific to
your account.

**Events reach Meta but don't show in Test Events.** Meta wants a browser user agent
for `action_source: "website"`, and this Worker has none (Give Lively doesn't pass
one, and the Worker doesn't invent one). If website events get dropped, set
`META_ACTION_SOURCE` to `system_generated` or `other` in the dashboard.

**Dashboard variables disappeared after a deploy.** Check that `"keep_vars": true` is
still in `wrangler.jsonc` and that the variable isn't also defined there.

**Logs.** Worker → Logs (observability is on). Each run logs one `poll` summary line
with counts and reason codes only.

## Privacy

- Sends only hashed email, first name, last name and phone, plus value, currency,
  event name and ticket count.
- D1 stores only IDs, timestamps, values and status codes.
- `/sample` returns field names and types, never values, unless you ask for specific
  non-personal fields.

## Development

```
npm install
npm run check   # typecheck + unit tests (vitest)
```

Tests use fake data and an in-memory store; they don't need Cloudflare. Code:

| File | Role |
|---|---|
| `src/index.ts` | `scheduled()` and `fetch()` entry points |
| `src/poll.ts` | One run: fetch, filter, dedupe, send, record |
| `src/fields.ts` | **Field name candidates.** Edit after discovery |
| `src/filter.ts` | `isTicketSale()` / `classify()` |
| `src/map.ts` | Record → Meta event, hashing |
| `src/meta.ts` | Conversions API client |
| `src/giveLively.ts` | Feed client (URL kept secret) |
| `src/db.ts` | D1 tables (created automatically) and queries |
| `src/admin.ts`, `src/console.ts` | Admin endpoints and console page |
| `src/schema.ts` | Value-free schema for `/sample` |

## License

MIT
