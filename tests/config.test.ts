import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads dotenv-style values and supports SAC browser session cookies", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hut-reservation-config-"));
    const dotenvPath = path.join(dir, ".env");
    await fs.writeFile(
      dotenvPath,
      [
        "HUT_RESERVATION_AUTH_MODE=sac",
        "HUT_RESERVATION_SESSION_COOKIE=session-from-dotenv",
        "HUT_RESERVATION_XSRF_TOKEN=\"xsrf-from-dotenv\"",
        "HUT_RESERVATION_CACHE_DIR=/tmp/from-dotenv"
      ].join("\n")
    );

    const config = loadConfig({ HUT_RESERVATION_DOTENV_PATH: dotenvPath });

    expect(config.cacheDir).toBe("/tmp/from-dotenv");
    expect(config.credentials).toEqual({
      mode: "sac",
      sessionCookie: "session-from-dotenv",
      xsrfToken: "xsrf-from-dotenv"
    });
  });

  it("lets process env override dotenv values and can parse a cookie header", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hut-reservation-config-"));
    const dotenvPath = path.join(dir, ".env");
    await fs.writeFile(
      dotenvPath,
      [
        "HUT_RESERVATION_AUTH_MODE=standard",
        "HUT_RESERVATION_USERNAME=person@example.com",
        "HUT_RESERVATION_PASSWORD=secret"
      ].join("\n")
    );

    const config = loadConfig({
      HUT_RESERVATION_DOTENV_PATH: dotenvPath,
      HUT_RESERVATION_AUTH_MODE: "sac",
      HUT_RESERVATION_COOKIE_HEADER: "SESSION=session-from-header; XSRF-TOKEN=xsrf-from-header"
    });

    expect(config.credentials).toEqual({
      mode: "sac",
      sessionCookie: "session-from-header",
      xsrfToken: "xsrf-from-header"
    });
  });

  it("parses and validates upstream request timeout", () => {
    expect(loadConfig({ HUT_RESERVATION_DOTENV_DISABLED: "true" }).requestTimeoutMs).toBe(15_000);
    expect(
      loadConfig({
        HUT_RESERVATION_DOTENV_DISABLED: "true",
        HUT_RESERVATION_REQUEST_TIMEOUT_MS: "2500"
      }).requestTimeoutMs
    ).toBe(2500);

    expect(() =>
      loadConfig({
        HUT_RESERVATION_DOTENV_DISABLED: "true",
        HUT_RESERVATION_REQUEST_TIMEOUT_MS: "0"
      })
    ).toThrow(/HUT_RESERVATION_REQUEST_TIMEOUT_MS must be a positive number/);
    expect(() =>
      loadConfig({
        HUT_RESERVATION_DOTENV_DISABLED: "true",
        HUT_RESERVATION_REQUEST_TIMEOUT_MS: "not-a-number"
      })
    ).toThrow(/HUT_RESERVATION_REQUEST_TIMEOUT_MS must be a positive number/);
  });
});
