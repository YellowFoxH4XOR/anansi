import { describe, expect, it } from "vitest";
import {
  consoleCredentialsFromEnv,
  isAuthorized,
  type ConsoleCredentials,
} from "../apps/console/security.js";

describe("console authentication", () => {
  it("requires a password in production", () => {
    expect(() => consoleCredentialsFromEnv({ NODE_ENV: "production" })).toThrow(
      "ANANSI_CONSOLE_PASSWORD is required",
    );
  });

  it("allows unauthenticated local development", () => {
    expect(consoleCredentialsFromEnv({ NODE_ENV: "development" })).toBeNull();
  });

  it("uses a safe default username", () => {
    expect(consoleCredentialsFromEnv({ ANANSI_CONSOLE_PASSWORD: "secret" })).toEqual({
      username: "anansi",
      password: "secret",
    });
  });

  it("rejects usernames that cannot be represented by Basic Auth", () => {
    expect(() =>
      consoleCredentialsFromEnv({
        ANANSI_CONSOLE_USERNAME: "bad:name",
        ANANSI_CONSOLE_PASSWORD: "secret",
      }),
    ).toThrow("cannot contain ':'");
  });

  it("accepts only the exact Basic Auth credentials", () => {
    const credentials: ConsoleCredentials = { username: "operator", password: "correct horse" };
    const valid = `Basic ${Buffer.from("operator:correct horse").toString("base64")}`;
    const invalid = `Basic ${Buffer.from("operator:wrong").toString("base64")}`;

    expect(isAuthorized(valid, credentials)).toBe(true);
    expect(isAuthorized(invalid, credentials)).toBe(false);
    expect(isAuthorized("Bearer anything", credentials)).toBe(false);
    expect(isAuthorized(undefined, credentials)).toBe(false);
  });
});
