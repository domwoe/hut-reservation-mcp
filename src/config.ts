import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AppConfig, AuthMode, Credentials } from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return value && value.trim().length > 0 ? value.trim() : null;
}

function numberEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = optionalEnv(env, key);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveNumberEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = optionalEnv(env, key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return parsed;
}

function authModeEnv(env: NodeJS.ProcessEnv): AuthMode {
  const mode = optionalEnv(env, "HUT_RESERVATION_AUTH_MODE");
  if (mode === "sac") return "sac";
  return "standard";
}

function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

function credentialsFromEnv(env: NodeJS.ProcessEnv): Credentials | null {
  const mode = authModeEnv(env);
  if (mode === "sac") {
    const cookieHeader = optionalEnv(env, "HUT_RESERVATION_COOKIE_HEADER");
    const cookies = parseCookieHeader(cookieHeader);
    const sessionCookie = optionalEnv(env, "HUT_RESERVATION_SESSION_COOKIE") ?? cookies.SESSION ?? null;
    const xsrfToken = optionalEnv(env, "HUT_RESERVATION_XSRF_TOKEN") ?? cookies["XSRF-TOKEN"] ?? null;
    if (!sessionCookie || !xsrfToken) return null;
    return { mode, sessionCookie, xsrfToken };
  }

  const username = optionalEnv(env, "HUT_RESERVATION_USERNAME");
  const password = optionalEnv(env, "HUT_RESERVATION_PASSWORD");
  if (!username || !password) return null;
  return { mode, username, password };
}

function unquoteDotenvValue(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "\"" && quote !== "'") || value[value.length - 1] !== quote) return value;
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;
  return inner
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function stripInlineComment(value: string): string {
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "\"" || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
    }
    if (char === "#" && quote === null && /\s/.test(value[index - 1] ?? "")) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function parseDotenv(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = stripInlineComment(withoutExport.slice(separator + 1).trim());
    parsed[key] = unquoteDotenvValue(value);
  }
  return parsed;
}

function loadDotenv(env: NodeJS.ProcessEnv): Record<string, string> {
  if (optionalEnv(env, "HUT_RESERVATION_DOTENV_DISABLED") === "true") return {};
  const dotenvPath = optionalEnv(env, "HUT_RESERVATION_DOTENV_PATH") ?? path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(dotenvPath)) return {};
  return parseDotenv(fs.readFileSync(dotenvPath, "utf8"));
}

function effectiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...loadDotenv(env), ...env };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const resolvedEnv = effectiveEnv(env);
  return {
    baseUrl: optionalEnv(resolvedEnv, "HUT_RESERVATION_BASE_URL") ?? "https://www.hut-reservation.org",
    cacheDir:
      optionalEnv(resolvedEnv, "HUT_RESERVATION_CACHE_DIR") ??
      path.join(os.homedir(), ".cache", "hut-reservation-mcp"),
    credentials: credentialsFromEnv(resolvedEnv),
    requestTimeoutMs: positiveNumberEnv(resolvedEnv, "HUT_RESERVATION_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS),
    experimentalWrites: optionalEnv(resolvedEnv, "HUT_RESERVATION_EXPERIMENTAL_WRITES") === "true",
    liveSmoke: optionalEnv(resolvedEnv, "HUT_RESERVATION_LIVE_SMOKE") === "true",
    nominatim: {
      baseUrl: optionalEnv(resolvedEnv, "NOMINATIM_BASE_URL"),
      userAgent: optionalEnv(resolvedEnv, "NOMINATIM_USER_AGENT"),
      email: optionalEnv(resolvedEnv, "NOMINATIM_EMAIL"),
      minIntervalMs: numberEnv(resolvedEnv, "NOMINATIM_MIN_INTERVAL_MS", 1000)
    }
  };
}
