import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  DEFAULT_GROK_MODEL,
  GROK_CHAT_COMPLETIONS_URL,
  completeStructured,
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
      max_tokens: 4096,
      response_format: {
        type: "json_schema",
        json_schema: { name: "smoke_pong", schema: echoJsonSchema, strict: true },
      },
    });
    expect(bodyAt(calls, 1).max_tokens).toBe(1024);
    expect(String(calls[0]?.init.body)).not.toContain(KEY);
    expect(logs).toEqual([]);
  });

  it("uses GROK_MODEL from the environment and defaults to grok-4.7", async () => {
    const { fetchImpl, calls } = mockFetch(async () => completion(JSON.stringify({ ok: true, echo: "pong" })));
    await completeStructured(args, options(fetchImpl, { env: { XAI_API_KEY: KEY, GROK_MODEL: "grok-4.5" } }));
    await completeStructured(args, options(fetchImpl, { env: { XAI_API_KEY: KEY } }));
    expect(bodyAt(calls, 0).model).toBe("grok-4.5");
    expect(bodyAt(calls, 1).model).toBe("grok-4.7");
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

  it("does not retry a schema rejection", async () => {
    const rejected = mockFetch(async () => errorResponse(400));
    const httpResult = await completeStructured(args, options(rejected.fetchImpl));
    expect(httpResult).toMatchObject({ ok: false, category: "schema", status: 400 });
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

  it("retries a timeout or network error and keeps the failure message generic", async () => {
    const recovered = mockFetch(async (call) => {
      if (call === 1) {
        const error = new Error(`connect failed while sending Bearer ${KEY}`);
        error.name = "AbortError";
        throw error;
      }
      return completion(JSON.stringify({ ok: true, echo: "pong" }));
    });
    const result = await completeStructured(args, options(recovered.fetchImpl));
    expect(result).toMatchObject({ ok: true, data: { echo: "pong" } });
    expect(recovered.calls).toHaveLength(2);
    expect(logs.join("\n")).toContain("category=network");
    expect(logs.join("\n")).not.toContain(KEY);

    delays = [];
    const failed = mockFetch(async () => {
      throw new Error("socket hang up");
    });
    const failure = await completeStructured(args, options(failed.fetchImpl));
    expect(failure).toEqual({ ok: false, category: "network", message: "network error calling the model API" });
    expect(failed.calls).toHaveLength(3);
    expect(JSON.stringify(failure)).not.toContain("socket hang up");
  });
});
