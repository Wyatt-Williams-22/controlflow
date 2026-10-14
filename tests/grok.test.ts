import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  DEFAULT_ANALYSIS_TIMEOUT_MS,
  DEFAULT_CLIENT_TIMEOUT_MS,
  DEFAULT_GROK_MODEL,
  GROK_CHAT_COMPLETIONS_URL,
  completeStructured,
  resolveTimeoutMs,
  type GrokClientOptions,
} from "../src/integrations/grok";

const KEY = "test-key-do-not-log";

const EchoSchema = z
  .object({
    ok: z.literal(true),
    echo: z.string(),
  })
  .strict();

const echoJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { const: true },
    echo: { type: "string" },
  },
  required: ["ok", "echo"],
};

const args = {
  schemaName: "smoke_pong",
  jsonSchema: echoJsonSchema,
  outputSchema: EchoSchema,
  system: "Reply with JSON.",
  user: "Set echo to pong.",
};

let delays: number[] = [];
let logs: string[] = [];

beforeEach(() => {
  delays = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.XAI_API_KEY;
  delete process.env.GROK_MODEL;
  delete process.env.GROK_TIMEOUT_MS;
});

function options(fetchImpl: typeof fetch, extra: Partial<GrokClientOptions> = {}): GrokClientOptions {
  return {
    env: { XAI_API_KEY: KEY, GROK_MODEL: DEFAULT_GROK_MODEL },
    fetchImpl,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
    ...extra,
  };
}

function mockFetch(handler: (call: number) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(calls.length);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function completion(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { type: "api_error" } }), { status });
}

function bodyAt(calls: Array<{ init: RequestInit }>, index: number): Record<string, unknown> {
  const raw = calls[index]?.init.body;
  if (typeof raw !== "string") throw new Error("expected a string request body");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("grok client", () => {
  it("posts a strict json_schema request and caps max_tokens", async () => {
    const { fetchImpl, calls } = mockFetch(async () => completion(JSON.stringify({ ok: true, echo: "pong" })));
    const clientOptions = options(fetchImpl);

    await completeStructured({ ...args, maxTokens: 100_000 }, clientOptions);
    await completeStructured(args, clientOptions);

    expect(calls[0]?.url).toBe(GROK_CHAT_COMPLETIONS_URL);
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(bodyAt(calls, 0)).toMatchObject({
      model: DEFAULT_GROK_MODEL,
      max_tokens: 16384,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: "smoke_pong", schema: echoJsonSchema, strict: true },
      },
    });
    expect(bodyAt(calls, 1).max_tokens).toBe(1024);
    expect(String(calls[0]?.init.body)).not.toContain(KEY);
    expect(logs).toEqual([]);
  });

  it("uses GROK_MODEL from the environment and otherwise uses the standard model", async () => {
    const { fetchImpl, calls } = mockFetch(async () => completion(JSON.stringify({ ok: true, echo: "pong" })));
    await completeStructured(args, options(fetchImpl, { env: { XAI_API_KEY: KEY, GROK_MODEL: "grok-4.5" } }));
    await completeStructured(args, options(fetchImpl, { env: { XAI_API_KEY: KEY } }));
    expect(bodyAt(calls, 0).model).toBe("grok-4.5");
    expect(bodyAt(calls, 1).model).toBe(DEFAULT_GROK_MODEL);
    expect(DEFAULT_GROK_MODEL).toBe("grok-4.20-0309-non-reasoning");
  });

  it("does not call the API when the key is missing", async () => {
    process.env.XAI_API_KEY = KEY;
    const { fetchImpl, calls } = mockFetch(async () => completion("{}"));
    const result = await completeStructured(args, options(fetchImpl, { env: {} }));

    expect(result).toEqual({ ok: false, category: "missing_api_key", message: "XAI_API_KEY is not set" });
    expect(calls).toHaveLength(0);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("does not retry 401 or 403 and does not log the key", async () => {
    for (const status of [401, 403]) {
      delays = [];
      const { fetchImpl, calls } = mockFetch(async () => errorResponse(status));
      const result = await completeStructured(args, options(fetchImpl));
      expect(result).toMatchObject({ ok: false, category: "unauthorized", status });
      expect(calls).toHaveLength(1);
      expect(delays).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(logs.join("\n")).not.toContain(KEY);
    }
  });

  it("classifies a no-credits HTTP 403 as quota_exhausted and does not retry", async () => {
    const body = {
      code: "permission-denied",
      error: `Your team ${KEY} has either used all available credits or reached its monthly spending limit.`,
    };
    const { fetchImpl, calls } = mockFetch(
      async () => new Response(JSON.stringify(body), { status: 403 }),
    );
    const result = await completeStructured(args, options(fetchImpl));

    expect(result).toEqual({
      ok: false,
      category: "quota_exhausted",
      message: "xAI account has no available credits or hit its spending limit.",
      status: 403,
    });
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain("Your team");
    expect(JSON.stringify(result)).not.toContain("monthly");
    expect(logs.join("\n")).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain("Your team");
    expect(logs.join("\n")).toContain("category=quota_exhausted");
  });

  it("keeps a permission-denied 403 without billing language as unauthorized", async () => {
    const { fetchImpl, calls } = mockFetch(
      async () =>
        new Response(JSON.stringify({ code: "permission-denied", error: "Request blocked for this model." }), {
          status: 403,
        }),
    );
    const result = await completeStructured(args, options(fetchImpl));
    expect(result).toEqual({
      ok: false,
      category: "unauthorized",
      message: "The API key was rejected.",
      status: 403,
    });
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("Request blocked");
  });

  it("classifies an invalid-key HTTP 400 as unauthorized and does not retry", async () => {
    const body = {
      code: "invalid-argument",
      error: `Incorrect API key provided: ${KEY}. You can obtain an API key from https://console.x.ai.`,
    };
    const { fetchImpl, calls } = mockFetch(
      async () => new Response(JSON.stringify(body), { status: 400 }),
    );
    const result = await completeStructured(args, options(fetchImpl));

    expect(result).toEqual({
      ok: false,
      category: "unauthorized",
      message: "The API key was rejected.",
      status: 400,
    });
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
    expect(logs.join("\n")).toContain("category=unauthorized");
  });

  it("does not treat a generic invalid-argument 400 as an auth or schema failure", async () => {
    const { fetchImpl, calls } = mockFetch(
      async () =>
        new Response(JSON.stringify({ code: "invalid-argument", error: "model is not available" }), {
          status: 400,
        }),
    );
    const result = await completeStructured(args, options(fetchImpl));
    expect(result).toMatchObject({
      ok: false,
      category: "bad_request",
      message: "model API rejected the request (400)",
      status: 400,
    });
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("does not retry a schema rejection", async () => {
    const rejected = mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            code: "invalid-argument",
            error: "response_format json_schema was rejected",
          }),
          { status: 400 },
        ),
    );
    const httpResult = await completeStructured(args, options(rejected.fetchImpl));
    expect(httpResult).toMatchObject({
      ok: false,
      category: "schema",
      message: "model API rejected the response schema",
      status: 400,
    });
    expect(rejected.calls).toHaveLength(1);

    const mismatched = mockFetch(async () => completion(JSON.stringify({ ok: false, echo: "nope" })));
    const parseResult = await completeStructured(args, options(mismatched.fetchImpl));
    expect(parseResult).toMatchObject({ ok: false, category: "schema" });
    expect(parseResult.ok ? "" : parseResult.message).not.toContain("nope");
    expect(mismatched.calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("retries 429 and 5xx with exponential backoff, then returns the typed error", async () => {
    const recovered = mockFetch(async (call) => (call === 1 ? errorResponse(429) : completion(JSON.stringify({ ok: true, echo: "pong" }))));
    const recoveredResult = await completeStructured(args, options(recovered.fetchImpl));
    expect(recoveredResult).toMatchObject({ ok: true, data: { ok: true, echo: "pong" }, model: DEFAULT_GROK_MODEL });
    expect(recovered.calls).toHaveLength(2);
    expect(delays).toEqual([250]);

    delays = [];
    const exhausted = mockFetch(async () => errorResponse(503));
    const exhaustedResult = await completeStructured(args, options(exhausted.fetchImpl));
    expect(exhaustedResult).toMatchObject({ ok: false, category: "server_error", status: 503 });
    expect(exhausted.calls).toHaveLength(3);
    expect(delays).toEqual([250, 500]);
  });

  it("does not retry a client timeout and keeps the message fixed", async () => {
    const aborted = mockFetch(async () => {
      const error = new Error(`The operation was aborted. Bearer ${KEY}`);
      error.name = "AbortError";
      throw error;
    });
    const abortedResult = await completeStructured(args, options(aborted.fetchImpl));
    expect(abortedResult).toEqual({ ok: false, category: "timeout", message: "The model call timed out." });
    expect(aborted.calls).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(JSON.stringify(abortedResult)).not.toContain(KEY);
    expect(logs.join("\n")).toContain("category=timeout");
    expect(logs.join("\n")).not.toContain(KEY);

    delays = [];
    logs.length = 0;
    const hung = {
      calls: 0,
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        hung.calls += 1;
        return await new Promise<Response>((_resolve, reject) => {
          const fail = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (!init?.signal) {
            reject(new Error("missing signal"));
            return;
          }
          if (init.signal.aborted) fail();
          else init.signal.addEventListener("abort", fail, { once: true });
        });
      }) as typeof fetch,
    };
    const started = Date.now();
    const hungResult = await completeStructured(
      args,
      options(hung.fetchImpl, { env: { XAI_API_KEY: KEY, GROK_TIMEOUT_MS: "40" } }),
    );
    expect(hungResult).toEqual({ ok: false, category: "timeout", message: "The model call timed out." });
    expect(hung.calls).toBe(1);
    expect(delays).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("retries a connection error and keeps the failure message generic", async () => {
    const failed = mockFetch(async () => {
      throw new Error("socket hang up");
    });
    const failure = await completeStructured(args, options(failed.fetchImpl));
    expect(failure).toEqual({ ok: false, category: "network", message: "network error calling the model API" });
    expect(failed.calls).toHaveLength(3);
    expect(JSON.stringify(failure)).not.toContain("socket hang up");
  });

  it("resolves GROK_TIMEOUT_MS above the client default and below the analysis default", () => {
    expect(resolveTimeoutMs(undefined, undefined, DEFAULT_CLIENT_TIMEOUT_MS)).toBe(60_000);
    expect(resolveTimeoutMs(undefined, undefined, DEFAULT_ANALYSIS_TIMEOUT_MS)).toBe(180_000);
    expect(resolveTimeoutMs(undefined, "90000", DEFAULT_ANALYSIS_TIMEOUT_MS)).toBe(90_000);
    expect(resolveTimeoutMs(5_000, "90000", DEFAULT_ANALYSIS_TIMEOUT_MS)).toBe(5_000);
    expect(resolveTimeoutMs(undefined, "soon", DEFAULT_CLIENT_TIMEOUT_MS)).toBe(60_000);
    expect(resolveTimeoutMs(undefined, "999999999", DEFAULT_CLIENT_TIMEOUT_MS)).toBe(600_000);
  });

  it("reports finish_reason=length as a cut-off response, not a schema error", async () => {
    const partial = `{"ok":true,"echo":"${KEY}`;
    const truncated = mockFetch(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ finish_reason: "length", message: { role: "assistant", content: partial } }] }),
          { status: 200 },
        ),
    );
    const truncatedResult = await completeStructured(args, options(truncated.fetchImpl));
    expect(truncatedResult).toEqual({
      ok: false,
      category: "invalid_response",
      message: "The model response was cut off because it reached max_tokens.",
      status: 200,
    });
    expect(truncated.calls).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(JSON.stringify(truncatedResult)).not.toContain(KEY);
    expect(JSON.stringify(truncatedResult)).not.toContain("finish_reason");

    const parsed = mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "length", message: { content: JSON.stringify({ ok: true, echo: "pong" }) } }],
          }),
          { status: 200 },
        ),
    );
    const parsedResult = await completeStructured(args, options(parsed.fetchImpl));
    expect(parsedResult).toMatchObject({
      ok: false,
      category: "invalid_response",
      message: "The model response was cut off because it reached max_tokens.",
    });
    expect(parsed.calls).toHaveLength(1);
  });
});
