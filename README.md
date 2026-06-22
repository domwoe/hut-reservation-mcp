# 🏔️ hut-reservation MCP

> Find, check, and book Swiss Alpine Club (SAC) huts straight from your AI agent — **write-safe by default**.

[![npm version](https://img.shields.io/npm/v/hut-reservation-mcp.svg)](https://www.npmjs.com/package/hut-reservation-mcp)
[![npm downloads](https://img.shields.io/npm/dm/hut-reservation-mcp.svg)](https://www.npmjs.com/package/hut-reservation-mcp)
[![license](https://img.shields.io/npm/l/hut-reservation-mcp.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives any MCP-capable agent (Claude, Codex, Cursor, …) the ability to search huts on [`hut-reservation.org`](https://www.hut-reservation.org), check exact-date availability, and prepare bookings and cancellations.

Ask your agent things like:

- *"Find huts within 20 km of Zermatt that have space for 2 people on 12 July."*
- *"Is the Cabane du Mont Fort free next weekend?"*
- *"Draft a booking for the Britanniahütte for 2 nights and give me the confirmation link."*
- *"List my upcoming hut reservations."*

**Why write-safe?** Bookings and cancellations never fire blind. By default the server *prepares a draft* and hands you a browser URL to confirm the final step yourself — so an agent can do all the searching and legwork without the risk of an accidental, hard-to-reverse reservation. Confirmed upstream writes are opt-in. See [Safety model](#safety-model).

---

## Quick start

```bash
npx hut-reservation-mcp
```

The server speaks MCP over stdio, so you normally don't run it by hand — you point your MCP client at it and let the client spawn it. Pick your client below.

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add hut-reservation -- npx -y hut-reservation-mcp
```

Restart Claude Code after adding so the server is respawned, then check `/mcp`.
</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add this to your `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "hut-reservation": {
      "command": "npx",
      "args": ["-y", "hut-reservation-mcp"]
    }
  }
}
```

Restart Claude Desktop after editing the file.
</details>

<details>
<summary><strong>Codex</strong></summary>

```bash
codex mcp add hut-reservation -- npx -y hut-reservation-mcp
```

Codex stores the server in `config.toml`. Start a **new** Codex session (MCP tools aren't injected into a running turn), then confirm with `/mcp` in the TUI.
</details>

<details>
<summary><strong>Cursor / other JSON-config clients</strong></summary>

Most clients accept a config of this shape:

```json
{
  "mcpServers": {
    "hut-reservation": {
      "command": "npx",
      "args": ["-y", "hut-reservation-mcp"],
      "env": {
        "HUT_RESERVATION_CACHE_DIR": "$HOME/.cache/hut-reservation-mcp"
      }
    }
  }
}
```
</details>

**The package ships with a bundled hut catalog** so `search_huts` and `search_hut_availability` work immediately without logging in. Availability lookups are also unauthenticated. You'll get a warning in results that the bundled catalog may be stale — run `refresh_hut_catalog` with credentials to update it. Booking, cancellation, listing your reservations, and refreshing the catalog require authentication. See [Configuration & authentication](#configuration--authentication).

---

## Tools

All tool-facing dates use ISO `YYYY-MM-DD`. The server translates to the upstream Swiss `DD.MM.YYYY` format internally.

| Tool | Purpose | Auth required | Writes? |
| --- | --- | :---: | :---: |
| `auth_status` | Report login, catalog, geocoder, area-cache, and draft-cache readiness. Run this first when diagnosing setup. | No | — |
| `search_huts` | Search cached huts by text, country, canton, or distance around coordinates. Uses bundled catalog if no local cache. | No¹ | — |
| `search_hut_availability` | Search exact-period availability for matched huts. Availability lookups are unauthenticated. | No¹ | — |
| `refresh_hut_catalog` | Refresh cached hut metadata from the upstream hut list. Replaces the bundled catalog with fresh data. | **Yes** | — |
| `refresh_area_cache` | Refresh canton/country area data via a reverse geocoder. Needs `NOMINATIM_BASE_URL`, not login. | No² | — |
| `prepare_booking` | Create a safe booking **draft** (does not confirm). | **Yes** | — |
| `confirm_booking` | Confirm a prepared booking, or return a browser handoff URL. | **Yes** | ⚠️ |
| `list_bookings` | List your reservations via the authenticated endpoint. | **Yes** | — |
| `prepare_cancellation` | Create a safe cancellation **draft** (does not confirm). | **Yes** | — |
| `confirm_cancellation` | Confirm a prepared cancellation, or return a browser handoff URL. | **Yes** | ⚠️ |

¹ Works without credentials using the bundled catalog. Results include a staleness warning; run `refresh_hut_catalog` with credentials to update.
² Requires a configured Nominatim-compatible geocoder (`NOMINATIM_BASE_URL`), but no hut-reservation.org login.

> ⚠️ Confirmation tools return a **browser handoff URL** by default. They only perform a real upstream write when [experimental writes](#safety-model) are explicitly enabled *and* a raw payload is supplied.

`search_hut_availability` checks every matched hut by default. Set `maxCandidates` only when you intentionally want a faster partial search; partial responses include `truncated`, `totalCandidates`, `checkedCandidates`, and a warning.

---

## Suggested workflows

**Find huts with availability** (no login needed for steps 1–2)

1. `search_huts` → 2. `search_hut_availability`. The bundled catalog is used automatically if no local cache exists; watch for the staleness warning.
3. Optionally: authenticate → `refresh_hut_catalog` → repeat for the latest hut list.
4. For canton filters: configure a reverse geocoder → `refresh_area_cache` (no login needed).

**Prepare a booking**

1. Search huts + availability → 2. `prepare_booking` → 3. review the draft → 4. `confirm_booking` → 5. complete the browser handoff (unless experimental writes are enabled).

**Prepare a cancellation**

1. Authenticate → 2. `list_bookings` → 3. `prepare_cancellation` → 4. review the draft → 5. `confirm_cancellation` → 6. complete the browser handoff (unless experimental writes are enabled).

---

## Safety model

High-risk upstream writes are intentionally conservative. The public SPA exposes `preBook`, `submit`, `myReservations`, `reservationSummary`, `delete/{id}`, and partial-cancellation-fee endpoints, but the full booking-form payload is not documented — so blind automated writes would be fragile and risky.

By default, `confirm_booking` and `confirm_cancellation` return a **browser handoff URL** instead of writing. A real write requires **both**:

- `HUT_RESERVATION_EXPERIMENTAL_WRITES=true`, and
- a caller-supplied raw payload.

Treat session cookies, XSRF tokens, passwords, and raw booking payloads as bearer credentials. Keep them in ignored local files, your MCP client's env config, or a secret manager. **Never commit them.**

---

## Configuration & authentication

### Do I need to authenticate?

**No — searching works out of the box.** The package bundles a hut catalog, and hut availability is a public endpoint, so you can find huts and check dates with zero setup. Add credentials only when you want fresher data or to touch your own reservations.

| What you want to do | Tools | Credentials |
| --- | --- | :---: |
| Search huts & check availability | `search_huts`, `search_hut_availability` | Not needed (uses the bundled catalog) |
| Update the catalog to the latest hut list | `refresh_hut_catalog` | **Required** |
| Get canton filters | `refresh_area_cache` | Not needed — but requires a geocoder |
| List your reservations | `list_bookings` | **Required** |
| Prepare / confirm a booking or cancellation | `prepare_booking`, `confirm_booking`, … | **Required** |

The bundled catalog only changes when huts open, close, or get renamed — rarely. Search results flag when it's getting old so your agent can suggest a `refresh_hut_catalog`.

### Which auth mode?

> **⚠️ If you log in to hut-reservation.org via the Swiss Alpine Club (i.e. your account is an SAC account), you must use `sac` mode.** The `standard` username/password flow only works for native hut-reservation.org accounts; an SAC-linked email will authenticate but the session is rejected as "Invalid Session". When in doubt, use `sac`.

**`standard`** — a native hut-reservation.org account (username + password):

```bash
HUT_RESERVATION_AUTH_MODE=standard
HUT_RESERVATION_USERNAME=person@example.com
HUT_RESERVATION_PASSWORD=...
```

**`sac`** — an SAC account, via browser-session cookies. Log in at `hut-reservation.org` through SAC in your browser, then open DevTools → **Application → Cookies → `https://www.hut-reservation.org`** and copy the `SESSION` and `XSRF-TOKEN` values:

```bash
HUT_RESERVATION_AUTH_MODE=sac
HUT_RESERVATION_SESSION_COOKIE=...
HUT_RESERVATION_XSRF_TOKEN=...
# or, equivalently, both in one header:
# HUT_RESERVATION_COOKIE_HEADER="SESSION=...; XSRF-TOKEN=..."
```

SAC cookies expire — when catalog refresh starts failing with an auth error, grab fresh cookie values from the browser.

### Setting these variables with the `npx` install

Because your MCP client (not your shell) spawns the server, set credentials in the client config rather than relying on a shell environment. Two options:

**1. Inline in the client's `env` block** (or `-e KEY=val` with `claude mcp add`):

```json
{
  "mcpServers": {
    "hut-reservation": {
      "command": "npx",
      "args": ["-y", "hut-reservation-mcp"],
      "env": {
        "HUT_RESERVATION_AUTH_MODE": "sac",
        "HUT_RESERVATION_SESSION_COOKIE": "...",
        "HUT_RESERVATION_XSRF_TOKEN": "..."
      }
    }
  }
}
```

**2. Point at a `.env` file by absolute path** — keeps secrets out of the client config:

```json
"env": { "HUT_RESERVATION_DOTENV_PATH": "/Users/me/.config/hut-reservation/.env" }
```

The server auto-loads `.env` from its working directory too, but under `npx` that directory is unpredictable, so prefer `HUT_RESERVATION_DOTENV_PATH`. Values from the `env` block override values from the `.env` file. See [`.env.example`](./.env.example) for a template, and treat cookies, tokens, and passwords as secrets — never commit them.

### All environment variables

| Variable | Description |
| --- | --- |
| `HUT_RESERVATION_AUTH_MODE` | `standard` (username/password) or `sac` (browser-session cookies). |
| `HUT_RESERVATION_USERNAME` / `HUT_RESERVATION_PASSWORD` | Standard `hut-reservation.org` credentials. |
| `HUT_RESERVATION_SESSION_COOKIE` / `HUT_RESERVATION_XSRF_TOKEN` | SAC `SESSION` and `XSRF-TOKEN` cookie values. |
| `HUT_RESERVATION_COOKIE_HEADER` | Combined cookie header, e.g. `SESSION=...; XSRF-TOKEN=...`. |
| `HUT_RESERVATION_CACHE_DIR` | Cache directory. Defaults to `~/.cache/hut-reservation-mcp`. |
| `HUT_RESERVATION_REQUEST_TIMEOUT_MS` | Upstream request timeout (ms). Default `15000`. |
| `HUT_RESERVATION_EXPERIMENTAL_WRITES` | `true` to allow raw-payload confirmed writes. Default `false`. |
| `HUT_RESERVATION_DOTENV_PATH` / `HUT_RESERVATION_DOTENV_DISABLED` | Point at a specific `.env`, or disable dotenv loading. |
| `NOMINATIM_BASE_URL` | Reverse geocoder base URL. Required before `refresh_area_cache` can geocode. |
| `NOMINATIM_USER_AGENT` / `NOMINATIM_EMAIL` / `NOMINATIM_MIN_INTERVAL_MS` | Identifying User-Agent, contact email, and rate limit for geocoder requests. |

### Reverse geocoder (optional, for canton filters)

```bash
NOMINATIM_BASE_URL=https://your-nominatim.example
NOMINATIM_USER_AGENT="hut-reservation-mcp/0.1.0 you@example.com"
NOMINATIM_MIN_INTERVAL_MS=1000
```

The server **never** uses public Nominatim implicitly. Configure an explicit provider and identifying User-Agent before calling `refresh_area_cache`. Follow the provider's usage policy, cache responses, and preserve OpenStreetMap attribution.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Search results include a stale bundled catalog warning | The bundled catalog is being used. Run `refresh_hut_catalog` with valid credentials to populate a local up-to-date copy. |
| `refresh_hut_catalog` fails with "Full authentication is required" | You're not authenticated. Configure credentials; the catalog endpoint is auth-gated. |
| Auth fails with "Invalid Session" | Your account is likely an SAC account — switch to `sac` mode with fresh browser cookies, or your SAC cookies have expired. |
| Canton filters return nothing | Configure a Nominatim-compatible geocoder, then run `refresh_area_cache`. |
| Availability searches are slow | Narrow your search filters first, or set `maxCandidates` for an intentional partial search. |
| Authenticated tools fail | Check `HUT_RESERVATION_AUTH_MODE` and credentials, then restart the client so it respawns the server with the new env. |
| Codex doesn't see the tools | Start a new Codex session (or reload), then check `/mcp`. |
| Confirmation returns a browser URL | Expected — unless `HUT_RESERVATION_EXPERIMENTAL_WRITES=true` and a raw payload are supplied. |

---

## Develop from source

```bash
git clone https://github.com/domwoe/hut-reservation-mcp.git
cd hut-reservation-mcp
pnpm install
pnpm dev          # run over stdio from TypeScript source
```

Point a client at your local checkout:

```bash
claude mcp add hut-reservation -- pnpm --dir /absolute/path/to/hut-reservation-mcp dev
# or, for the built entrypoint:
pnpm build
claude mcp add hut-reservation -- node /absolute/path/to/hut-reservation-mcp/dist/index.js
```

### Regenerating the bundled catalog

The package ships `data/catalog.json` so users can search without authenticating. Regenerate it before releasing a new version:

```bash
# Requires valid credentials in .env (standard or sac mode)
pnpm generate:catalog
# then commit data/catalog.json and bump the version
```

The hut catalog changes rarely (new huts open, names change). Regenerating once per release is sufficient.

### Verification

```bash
pnpm typecheck
pnpm test
pnpm run smoke:mcp:source
pnpm build
pnpm run smoke:mcp:dist
```

Optional read-only live smoke test against upstream:

```bash
HUT_RESERVATION_LIVE_SMOKE=true pnpm smoke:read
```

---

## Disclaimer

This is an unofficial, community project and is not affiliated with the Swiss Alpine Club (SAC) or `hut-reservation.org`. Use it responsibly and in line with the site's terms of service.
</content>
</invoke>
