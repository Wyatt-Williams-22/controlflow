import "server-only";

import { z } from "zod";

/**
 * Server-only client for one xAI Chat Completions call.
 *
 * Checked against https://docs.x.ai/docs/guides/structured-outputs (2026-10-14):
 *   POST https://api.x.ai/v1/chat/completions
 *   Authorization: Bearer XAI_API_KEY
 *   response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }
 *   The JSON text comes back on choices[0].message.content.
 *
 * The docs do not set a request timeout, so this client aborts after 60 seconds.
 * Retry up to twice, with exponential backoff, only for HTTP 429, HTTP 5xx,
 * and network or timeout errors. Never retry 401, 403, or a schema failure.
 *
 * This file logs a category, a status, and an attempt number. It does not log
 * the API key, the prompt, or the response body.
 */

export const GROK_CHAT_COMPLETIONS_URL = "https://api.x.ai/v1/chat/completions";
export const DEFAULT_GROK_MODEL = "grok-4.7";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 1_024;
const MAX_TOKENS_CAP = 4_096;
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 250;
const MAX_RESPONSE_CHARS = 1_000_000;

export const grokErrorCategories = [
  "missing_api_key",
  "unauthorized",
  "rate_limited",
  "server_error",
  "network",
  "schema",
  "invalid_response",
  "bad_request",
] as const;

export type GrokErrorCategory = (typeof grokErrorCategories)[number];

export type GrokFailure = {
  ok: false;
  category: GrokErrorCategory;
  message: string;
  status?: number;
};

export type GrokSuccess<T> = {
  ok: true;
  data: T;
  model: string;
};

export type GrokCallArgs<T> = {
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  outputSchema: z.ZodType<T>;
  system: string;
  user: string;
  maxTokens?: number;
};

export type GrokClientOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  apiKey?: string;
  model?: string;
  maxRetries?: number;
  env?: { XAI_API_KEY?: string; GROK_MODEL?: string };
  /** The workflow turns this off. Smoke and unit tests keep the category line. */
  logFailures?: boolean;
};

type EnvLike = { XAI_API_KEY?: string; GROK_MODEL?: string };

function readEnv(options: GrokClientOptions): EnvLike {
  if (options.env) return options.env;
  return {
    XAI_API_KEY: process.env.XAI_API_KEY,
    GROK_MODEL: process.env.GROK_MODEL,
  };
}

export function boundedMaxTokens(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return DEFAULT_MAX_TOKENS;
  }
  return Math.min(Math.floor(requested), MAX_TOKENS_CAP);
}

export async function completeStructured<T>(
  args: GrokCallArgs<T>,
  options: GrokClientOptions = {},
): Promise<GrokSuccess<T> | GrokFailure> {
  const env = readEnv(options);
  const apiKey = (options.apiKey !== undefined ? options.apiKey : env.XAI_API_KEY ?? "").trim();
  const configuredModel = (options.model !== undefined ? options.model : env.GROK_MODEL ?? "").trim();
  const model = configuredModel || DEFAULT_GROK_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const reportFailure = (failure: GrokFailure, attempt: number) => {
    if (options.logFailures === false) return;
    logFailure(failure, attempt);
  };

  if (!apiKey) {
    const failure = fail("missing_api_key", "XAI_API_KEY is not set");
    reportFailure(failure, 0);
    return failure;
  }

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(args.schemaName)) {
    return fail("bad_request", "schema name is not a short identifier");
  }
  if (args.system.trim().length === 0 || args.user.trim().length === 0) {
    return fail("bad_request", "system and user messages are required");
  }

  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
    max_tokens: boundedMaxTokens(args.maxTokens),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: args.schemaName,
        schema: args.jsonSchema,
        strict: true,
      },
    },
  });

  let lastFailure: GrokFailure | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        fetchImpl,
        GROK_CHAT_COMPLETIONS_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
        },
        timeoutMs,
      );
    } catch (error) {
      lastFailure = fail("network", networkMessage(error));
      reportFailure(lastFailure, attempt);
      continue;
    }

    if (response.ok) {
      const result = await readSuccess(response, args.outputSchema, model);
      if (!result.ok) reportFailure(result, attempt);
      return result;
    }

    await discardBody(response);
    const category = categoryForStatus(response.status);
    lastFailure = fail(category, httpMessage(category, response.status), response.status);
    reportFailure(lastFailure, attempt);
    if (!isRetryableStatus(response.status)) return lastFailure;
  }

  return lastFailure ?? fail("network", "model request failed");
}

function categoryForStatus(status: number): GrokErrorCategory {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "server_error";
  // Rejected JSON schemas come back as HTTP 400. Do not retry that.
  if (status === 400) return "schema";
  return "bad_request";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function fail(category: GrokErrorCategory, message: string, status?: number): GrokFailure {
  return status === undefined ? { ok: false, category, message } : { ok: false, category, message, status };
}

function httpMessage(category: GrokErrorCategory, status: number): string {
  if (category === "unauthorized") return "model API rejected the credentials";
  if (category === "rate_limited") return "model API rate limit exceeded";
  if (category === "server_error") return "model API returned a server error";
  if (category === "schema") return "model API rejected the response schema";
  return `model API rejected the request (${status})`;
}

function networkMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "model request timed out";
  return "network error calling the model API";
}

function logFailure(failure: GrokFailure, attempt: number): void {
  console.error(
    `grok category=${failure.category} status=${failure.status ?? "none"} attempt=${attempt}`,
  );
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status code is enough. The body is not logged.
  }
}

async function readSuccess<T>(
  response: Response,
  outputSchema: z.ZodType<T>,
  model: string,
): Promise<GrokSuccess<T> | GrokFailure> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return fail("invalid_response", "model response body could not be read", response.status);
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    return fail("invalid_response", "model response body exceeded the size cap", response.status);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return fail("invalid_response", "model response was not JSON", response.status);
  }

  const content = readMessageContent(payload);
  if (content.kind === "refusal") {
    return fail("invalid_response", "model refused the request", response.status);
  }
  if (content.kind !== "text") {
    return fail("invalid_response", "model response did not include message content", response.status);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.text);
  } catch {
    return fail("schema", "model content was not JSON", response.status);
  }

  const checked = outputSchema.safeParse(parsed);
  if (!checked.success) {
    const paths = checked.error.issues
      .map((issue) => issue.path.join("."))
      .filter((path) => path.length > 0)
      .slice(0, 5);
    const where = paths.length > 0 ? ` at ${paths.join(", ")}` : "";
    return fail("schema", `model output did not match schema${where}`, response.status);
  }

  return { ok: true, data: checked.data, model };
}

function readMessageContent(
  payload: unknown,
): { kind: "text"; text: string } | { kind: "refusal" } | { kind: "missing" } {
  if (typeof payload !== "object" || payload === null) return { kind: "missing" };
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { kind: "missing" };
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  if (typeof message !== "object" || message === null) return { kind: "missing" };
  const record = message as { content?: unknown; refusal?: unknown };
  if (typeof record.refusal === "string" && record.refusal.length > 0 && record.content == null) {
    return { kind: "refusal" };
  }
  if (typeof record.content !== "string" || record.content.length === 0) return { kind: "missing" };
  return { kind: "text", text: record.content };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
