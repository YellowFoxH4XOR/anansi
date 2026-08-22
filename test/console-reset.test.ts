import { describe, expect, it } from "vitest";
import { forwardStateReset } from "../apps/console/reset.js";

const successBody = {
  cleared: true,
  removed: ["state.json"],
  collectors: [{ collectorId: "c_live", scraper: "c_live" }],
  errors: [],
};

describe("console state reset proxy", () => {
  it("rejects a missing confirmation before calling the agent", async () => {
    let called = false;
    const fakeFetch: typeof fetch = async () => {
      called = true;
      return new Response();
    };

    const result = await forwardStateReset("http://agent:4800", undefined, fakeFetch);

    expect(result).toEqual({ status: 400, body: { error: "confirmation is required" } });
    expect(called).toBe(false);
  });

  it("forwards the confirmation to the internal agent service", async () => {
    let requestedUrl = "";
    let requestedBody = "";
    const fakeFetch: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body);
      return new Response(JSON.stringify(successBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await forwardStateReset("http://agent:4800", "RESET ALL STATE", fakeFetch);

    expect(requestedUrl).toBe("http://agent:4800/state/reset");
    expect(JSON.parse(requestedBody)).toEqual({ confirmation: "RESET ALL STATE" });
    expect(result).toEqual({ status: 200, body: successBody });
  });

  it("reports an unavailable agent without exposing a transport error", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("connection refused at internal address");
    };

    expect(await forwardStateReset("http://agent:4800", "RESET ALL STATE", fakeFetch)).toEqual({
      status: 503,
      body: { error: "agent control service is unavailable" },
    });
  });
});
