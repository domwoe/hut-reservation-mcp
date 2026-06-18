# hut-reservation MCP

Local-first Model Context Protocol (MCP) server for searching SAC huts, checking availability, and preparing booking or cancellation handoffs on `hut-reservation.org`.

The server is designed for agent use over stdio. It keeps high-risk upstream writes conservative by default: booking and cancellation confirmation tools prepare browser handoffs unless experimental writes are explicitly enabled.

## Capabilities

- Search huts by country, canton cache, text, and distance around coordinates.
- Refresh the hut catalog from `hutsList` plus `hutInfo`.
- Refresh canton and country area data through an explicitly configured Nominatim-compatible reverse geocoder.
- Search exact-period availability using `YYYY-MM-DD` at the MCP boundary and the upstream Swiss `DD.MM.YYYY` format internally.
- Report catalog, area-cache, geocoder, and draft-cache readiness through `auth_status`.
- Create safe booking and cancellation drafts.
- List reservations through the authenticated `myReservations` endpoint.

## Safety model

Headless booking and confirmed-reservation cancellation are intentionally conservative. The public SPA exposes `preBook`, `submit`, `myReservations`, `reservationSummary`, `delete/{id}`, and partial-cancellation-fee endpoints, but the complete booking form payload is not documented.

By default, confirmation tools return a browser handoff URL instead of performing writes. Experimental writes require both:

- `HUT_RESERVATION_EXPERIMENTAL_WRITES=true`
- A caller-supplied raw payload

Treat session cookies, XSRF tokens, passwords, and raw booking payloads as bearer credentials. Keep them in ignored local files, your MCP client environment configuration, or a secret manager. Do not commit them.

## Prerequisites

- Node.js and pnpm.
- A local checkout of this repository.
- Optional: a `hut-reservation.org` account or SAC browser session for authenticated reservation tools.
- Optional: a Nominatim-compatible reverse geocoder for canton and country area-cache refreshes.

## Quick start

Install dependencies:

```bash
pnpm install
```

Run locally over stdio:

```bash
pnpm dev
```

MCP clients should spawn the server rather than connect to an already-running shell process:

```bash
pnpm --dir /absolute/path/to/hut-reservation-mcp dev
```

For built usage, compile first and spawn the compiled entrypoint:

```bash
pnpm build
node /absolute/path/to/hut-reservation-mcp/dist/index.js
```

## MCP client configuration

Most MCP clients accept a JSON configuration shaped like this:

```json
{
  "mcpServers": {
    "hut-reservation": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/hut-reservation-mcp", "dev"],
      "env": {
        "HUT_RESERVATION_CACHE_DIR": "$HOME/.cache/hut-reservation-mcp"
      }
    }
  }
}
```

Use the built entrypoint after running `pnpm build`:

```json
{
  "mcpServers": {
    "hut-reservation": {
      "command": "node",
      "args": ["/absolute/path/to/hut-reservation-mcp/dist/index.js"]
    }
  }
}
```

### Codex

MCP tools are not imported into an already-running Codex turn by starting the server manually. The native workflow is:

1. Register the MCP server with `codex mcp add`.
2. Start a new Codex session, or reload the client.
3. Check `/mcp` in the Codex TUI and then ask Codex to use the hut-reservation tools.

For local checkout development, register the source-backed command so MCP sessions run the current TypeScript source:

```bash
codex mcp add hut-reservation -- pnpm --dir /absolute/path/to/hut-reservation-mcp dev
```

For this checkout:

```bash
codex mcp add hut-reservation -- pnpm --dir /Users/domwoe/Dev/projects/hut-reservation-mcp dev
```

Codex stores that server in `config.toml`. After the next session starts, the MCP tools are available natively to the model rather than through shell commands.

For built or packaged usage:

```bash
pnpm build
codex mcp add hut-reservation -- node /absolute/path/to/hut-reservation-mcp/dist/index.js
```

### Claude Code

Use the Claude Code CLI to register the source-backed server:

```bash
claude mcp add hut-reservation -- pnpm --dir /absolute/path/to/hut-reservation-mcp dev
```

For this checkout:

```bash
claude mcp add hut-reservation -- pnpm --dir /Users/domwoe/Dev/projects/hut-reservation-mcp dev
```

For built or packaged usage:

```bash
pnpm build
claude mcp add hut-reservation -- node /absolute/path/to/hut-reservation-mcp/dist/index.js
```

Restart Claude Code after changing MCP configuration so the server is respawned with the updated command and environment.

### Claude Desktop

Add the server to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "hut-reservation": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/hut-reservation-mcp", "dev"],
      "env": {
        "HUT_RESERVATION_CACHE_DIR": "$HOME/.cache/hut-reservation-mcp"
      }
    }
  }
}
```

For this checkout:

```json
{
  "mcpServers": {
    "hut-reservation": {
      "command": "pnpm",
      "args": ["--dir", "/Users/domwoe/Dev/projects/hut-reservation-mcp", "dev"],
      "env": {
        "HUT_RESERVATION_CACHE_DIR": "$HOME/.cache/hut-reservation-mcp"
      }
    }
  }
}
```

For built or packaged usage:

```json
{
  "mcpServers": {
    "hut-reservation": {
      "command": "node",
      "args": ["/absolute/path/to/hut-reservation-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop after editing the configuration file.

## Configuration

The server loads `.env` from the current working directory before reading environment variables.

| Variable | Required | Description |
| --- | --- | --- |
| `HUT_RESERVATION_DOTENV_PATH` | No | Path to a specific `.env` file. |
| `HUT_RESERVATION_DOTENV_DISABLED` | No | Set to `true` to disable dotenv loading. |
| `HUT_RESERVATION_AUTH_MODE` | No | Authentication mode. Use `standard` for username/password or `sac` for SAC browser-session cookies. |
| `HUT_RESERVATION_USERNAME` | No | Standard `hut-reservation.org` username. |
| `HUT_RESERVATION_PASSWORD` | No | Standard `hut-reservation.org` password. |
| `HUT_RESERVATION_SESSION_COOKIE` | No | SAC `SESSION` cookie value. |
| `HUT_RESERVATION_XSRF_TOKEN` | No | SAC `XSRF-TOKEN` cookie value. |
| `HUT_RESERVATION_COOKIE_HEADER` | No | Combined cookie header, for example `SESSION=...; XSRF-TOKEN=...`. |
| `HUT_RESERVATION_CACHE_DIR` | No | Cache directory. Defaults to the server's local cache behavior. |
| `HUT_RESERVATION_REQUEST_TIMEOUT_MS` | No | Upstream request timeout in milliseconds. |
| `HUT_RESERVATION_EXPERIMENTAL_WRITES` | No | Set to `true` to allow raw-payload experimental write confirmation. |
| `NOMINATIM_BASE_URL` | No | Base URL for a Nominatim-compatible reverse geocoder. Required before `refresh_area_cache` can use geocoding. |
| `NOMINATIM_USER_AGENT` | No | Identifying User-Agent for geocoder requests. |
| `NOMINATIM_EMAIL` | No | Contact email for geocoder requests, if required by the provider. |
| `NOMINATIM_MIN_INTERVAL_MS` | No | Minimum interval between geocoder requests. |

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

You can copy these values from DevTools after logging in through SAC:
Application -> Cookies -> `https://www.hut-reservation.org` -> `SESSION` and `XSRF-TOKEN`.

Alternatively, provide both cookies as one header:

```bash
HUT_RESERVATION_AUTH_MODE=sac
HUT_RESERVATION_COOKIE_HEADER="SESSION=...; XSRF-TOKEN=..."
```

### Cache and timeout

```bash
HUT_RESERVATION_CACHE_DIR="$HOME/.cache/hut-reservation-mcp"
HUT_RESERVATION_REQUEST_TIMEOUT_MS=15000
```

### Reverse geocoder

```bash
NOMINATIM_BASE_URL=https://your-nominatim.example
NOMINATIM_USER_AGENT="hut-reservation-mcp/0.1.0 you@example.com"
NOMINATIM_EMAIL=you@example.com
NOMINATIM_MIN_INTERVAL_MS=1000
```

The server never uses public Nominatim implicitly. Configure a base URL and identifying User-Agent before calling `refresh_area_cache`. Follow the provider's usage policy, cache responses, and preserve OpenStreetMap attribution.

## Tools

All tool-facing dates are `YYYY-MM-DD`.

| Tool | Purpose | Notes |
| --- | --- | --- |
| `auth_status` | Report login, catalog, geocoder, area-cache, and draft-cache readiness. | Use this first when diagnosing setup. |
| `refresh_hut_catalog` | Refresh cached hut metadata from upstream hut list and detail endpoints. | Run before searching if the local catalog is empty or stale. |
| `refresh_area_cache` | Refresh cached canton and country area data through a configured reverse geocoder. | Requires `NOMINATIM_BASE_URL` and identifying geocoder configuration. |
| `search_huts` | Search cached huts by text, country, canton, or distance around coordinates. | Canton filters depend on a refreshed area cache. |
| `search_hut_availability` | Search exact-period availability for matched cached huts. | Checks every matched cached hut by default. |
| `prepare_booking` | Create a safe booking draft. | Does not confirm the booking. |
| `confirm_booking` | Confirm a prepared booking or return a browser handoff URL. | Raw-payload writes require experimental writes. |
| `list_bookings` | List reservations through the authenticated `myReservations` endpoint. | Requires authenticated upstream access. |
| `prepare_cancellation` | Create a safe cancellation draft. | Does not confirm cancellation. |
| `confirm_cancellation` | Confirm a prepared cancellation or return a browser handoff URL. | Raw-payload writes require experimental writes. |

`search_hut_availability` checks every matched cached hut by default. Set `maxCandidates` only when you intentionally want a faster partial search; partial responses include `truncated`, `totalCandidates`, `checkedCandidates`, and a warning.

## Suggested workflows

### Find huts with availability

1. Call `auth_status`.
2. If the catalog is missing or stale, call `refresh_hut_catalog`.
3. If you need canton filters, configure the reverse geocoder and call `refresh_area_cache`.
4. Call `search_huts`.
5. Call `search_hut_availability` with ISO dates.

### Prepare a booking

1. Search huts and availability first.
2. Call `prepare_booking`.
3. Review the draft details.
4. Call `confirm_booking`.
5. Complete the browser handoff unless experimental writes are intentionally enabled.

### Prepare a cancellation

1. Authenticate with standard credentials or SAC session cookies.
2. Call `list_bookings`.
3. Call `prepare_cancellation`.
4. Review the draft details.
5. Call `confirm_cancellation`.
6. Complete the browser handoff unless experimental writes are intentionally enabled.

## Troubleshooting

- `auth_status` reports no catalog: run `refresh_hut_catalog`.
- Canton filters return nothing: configure a Nominatim-compatible geocoder and run `refresh_area_cache`.
- Availability searches are slow: add narrower search filters first, or set `maxCandidates` when a partial search is acceptable.
- Authenticated tools fail: verify `HUT_RESERVATION_AUTH_MODE` and credential variables, then restart the MCP client so it respawns the server with the new environment.
- Codex does not see the tools: restart the Codex session or reload the client after `codex mcp add`, then check `/mcp`.
- Confirmation returns a browser URL: this is expected unless `HUT_RESERVATION_EXPERIMENTAL_WRITES=true` and a raw payload are supplied.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm run smoke:mcp:source
pnpm build
pnpm run smoke:mcp:dist
```

Optional read-only live smoke test:

```bash
HUT_RESERVATION_LIVE_SMOKE=true pnpm smoke:read
```
