# 🏔️ hut-reservation MCP

> Find, check, and book Swiss Alpine Club (SAC) huts straight from your AI agent — **write-safe by default**.

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

Authenticated tools (your reservations, cancellations) need credentials — see [Configuration](#configuration). Searching and availability work without logging in.

---

## Tools

All tool-facing dates use ISO `YYYY-MM-DD`. The server translates to the upstream Swiss `DD.MM.YYYY` format internally.

| Tool | Purpose | Auth | Writes? |
| --- | --- | :---: | :---: |
| `auth_status` | Report login, catalog, geocoder, area-cache, and draft-cache readiness. Run this first when diagnosing setup. | — | — |
| `refresh_hut_catalog` | Refresh cached hut metadata from the upstream hut list + detail endpoints. | — | — |
| `refresh_area_cache` | Refresh canton/country area data via a configured reverse geocoder. Needs `NOMINATIM_BASE_URL`. | — | — |
| `search_huts` | Search cached huts by text, country, canton, or distance around coordinates. | — | — |
| `search_hut_availability` | Search exact-period availability for matched huts. Checks every matched hut by default. | — | — |
| `prepare_booking` | Create a safe booking **draft** (does not confirm). | — | — |
| `confirm_booking` | Confirm a prepared booking, or return a browser handoff URL. | ✅ | ⚠️ |
| `list_bookings` | List your reservations via the authenticated `myReservations` endpoint. | ✅ | — |
| `prepare_cancellation` | Create a safe cancellation **draft** (does not confirm). | ✅ | — |
| `confirm_cancellation` | Confirm a prepared cancellation, or return a browser handoff URL. | ✅ | ⚠️ |

> ⚠️ Confirmation tools return a **browser handoff URL** by default. They only perform a real upstream write when [experimental writes](#safety-model) are explicitly enabled *and* a raw payload is supplied.

`search_hut_availability` checks every matched hut by default. Set `maxCandidates` only when you intentionally want a faster partial search; partial responses include `truncated`, `totalCandidates`, `checkedCandidates`, and a warning.

---

## Suggested workflows

**Find huts with availability**

1. `auth_status` → 2. `refresh_hut_catalog` (if catalog is missing/stale) → 3. `refresh_area_cache` (only if you need canton filters) → 4. `search_huts` → 5. `search_hut_availability`.

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

## Configuration

The server loads `.env` from the current working directory before reading environment variables. See [`.env.example`](./.env.example) for a template.

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

### Standard account login

```bash
HUT_RESERVATION_AUTH_MODE=standard
HUT_RESERVATION_USERNAME=person@example.com
HUT_RESERVATION_PASSWORD=...
```

### SAC browser-session login

```bash
HUT_RESERVATION_AUTH_MODE=sac
HUT_RESERVATION_SESSION_COOKIE=...
HUT_RESERVATION_XSRF_TOKEN=...
```

Copy these from DevTools after logging in through SAC: **Application → Cookies → `https://www.hut-reservation.org` → `SESSION` and `XSRF-TOKEN`.** Or pass both as one header via `HUT_RESERVATION_COOKIE_HEADER`.

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
| `auth_status` reports no catalog | Run `refresh_hut_catalog`. |
| Canton filters return nothing | Configure a Nominatim-compatible geocoder, then run `refresh_area_cache`. |
| Availability searches are slow | Narrow your search filters first, or set `maxCandidates` for an intentional partial search. |
| Authenticated tools fail | Check `HUT_RESERVATION_AUTH_MODE` and credentials, then restart the client so it respawns the server with the new env. |
| Codex doesn't see the tools | Start a new Codex session (or reload), then check `/mcp`. |
| Confirmation returns a browser URL | Expected — unless `HUT_RESERVATION_EXPERIMENTAL_WRITES=true` and a raw payload are supplied. |

---

## Develop from source

```bash
git clone https://github.com/<you>/hut-reservation-mcp.git
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
