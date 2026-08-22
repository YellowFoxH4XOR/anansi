export type ResetStatePayload = {
  cleared: boolean;
  removed: string[];
  collectors: { collectorId: string; scraper: string; platformName?: string }[];
  errors: string[];
  error?: string;
};

export type ResetProxyResult = {
  status: number;
  body: ResetStatePayload | { error: string };
};

export async function forwardStateReset(
  controlUrl: string,
  confirmation: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<ResetProxyResult> {
  if (typeof confirmation !== "string") {
    return { status: 400, body: { error: "confirmation is required" } };
  }

  try {
    const response = await fetchImpl(new URL("/state/reset", controlUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({ error: "invalid control response" }))) as ResetProxyResult["body"];
    return { status: response.status, body };
  } catch {
    return { status: 503, body: { error: "agent control service is unavailable" } };
  }
}
