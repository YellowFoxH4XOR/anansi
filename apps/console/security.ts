import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export type ConsoleCredentials = Readonly<{
  username: string;
  password: string;
}>;

export function consoleCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConsoleCredentials | null {
  const password = env.ANANSI_CONSOLE_PASSWORD;
  if (!password) {
    if (env.NODE_ENV === "production") {
      throw new Error("ANANSI_CONSOLE_PASSWORD is required when NODE_ENV=production");
    }
    return null;
  }

  const username = env.ANANSI_CONSOLE_USERNAME?.trim() || "anansi";
  if (username.includes(":")) {
    throw new Error("ANANSI_CONSOLE_USERNAME cannot contain ':'");
  }

  return { username, password };
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isAuthorized(
  authorization: string | undefined,
  credentials: ConsoleCredentials,
): boolean {
  if (!authorization) return false;
  const expected = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  return equalSecret(authorization, expected);
}

export function basicAuth(credentials: ConsoleCredentials): RequestHandler {
  return (req, res, next) => {
    if (isAuthorized(req.header("authorization"), credentials)) {
      next();
      return;
    }

    res.setHeader("WWW-Authenticate", 'Basic realm="ANANSI console", charset="UTF-8"');
    res.status(401).json({ error: "authentication required" });
  };
}

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
};
