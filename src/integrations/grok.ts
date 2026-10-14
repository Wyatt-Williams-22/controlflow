import "server-only";

import { z } from "zod";

import { DEFAULT_DEEP_MODEL, DEFAULT_STANDARD_MODEL } from "../types/job-view";

/**
 * Server-only client for one xAI Chat Completions call.
 *
 * Checked against https://docs.x.ai/docs/guides/structured-outputs (2026-10-14):
 *   POST https://api.x.ai/v1/chat/completions
 *   Authorization: Bearer XAI_API_KEY
 *   response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }
 *   The JSON text comes back on choices[0].message.content.
 *
 * The docs do not set a request timeout. Direct calls, including smoke, abort
 * after 60 seconds unless GROK_TIMEOUT_MS or timeoutMs is set. Standard
 * analysis uses 180 seconds. Deep analysis uses 360 seconds. GROK_TIMEOUT_MS
 * still overrides both.
 * Retry up to twice, with exponential backoff, only for HTTP 429, HTTP 5xx,
 * and connection errors. Never retry a client timeout, 401, 403 (including a
 * credits or spending-limit 403), an invalid-key 400, or a schema failure.
 *
 * This file logs a category, a status, and an attempt number. It does not log
 * the API key, the prompt, or the response body.
 */

export const GROK_CHAT_COMPLETIONS_URL = "https://api.x.ai/v1/chat/completions";
export const DEFAULT_GROK_MODEL = DEFAULT_STANDARD_MODEL;
export const DEFAULT_DEEP_GROK_MODEL = DEFAULT_DEEP_MODEL;

/** Used when a caller does not set timeoutMs or GROK_TIMEOUT_MS. Smoke stays on this. */
export const DEFAULT_CLIENT_TIMEOUT_MS = 60_000;
/** Standard analysis. One structured response can outlast the smoke default. */
export const DEFAULT_ANALYSIS_TIMEOUT_MS = 180_000;
/** Deep analysis uses the reasoning model, which has taken about three minutes on this packet. */
export const DEFAULT_DEEP_TIMEOUT_MS = 360_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 1_024;
/** Analysis asks for this many tokens. The client cap is higher so a caller can go further. */
export const ANALYSIS_MAX_TOKENS = 8_192;
const MAX_TOKENS_CAP = 16_384;
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 250;
const MAX_RESPONSE_CHARS = 1_000_000;

export const grokErrorCategories = [
  "missing_api_key",
  "unauthorized",
  "quota_exhausted",
  "rate_limited",
  "server_error",
  "network",
  "timeout",
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
  env?: { XAI_API_KEY?: string; GROK_MODEL?: string; GROK_DEEP_MODEL?: string; GROK_TIMEOUT_MS?: string };
  /** The workflow turns this off. Smoke and unit tests keep the category line. */
  logFailures?: boolean;
};

type EnvLike = { XAI_API_KEY?: string; GROK_MODEL?: string; GROK_DEEP_MODEL?: string; GROK_TIMEOUT_MS?: string };

function readEnv(options: GrokClientOptions): EnvLike {
  if (options.env) return options.env;
  return {
    XAI_API_KEY: process.env.XAI_API_KEY,
    GROK_MODEL: process.env.GROK_MODEL,
    GROK_DEEP_MODEL: process.env.GROK_DEEP_MODEL,
    GROK_TIMEOUT_MS: process.env.GROK_TIMEOUT_MS,
  };
}

/**
 * explicit timeoutMs wins, then GROK_TIMEOUT_MS, then fallback.
 * A blank or non-numeric env value is ignored. Values above 10 minutes are capped.
 */
export function resolveTimeoutMs(explicit: number | undefined, envValue: string | undefined, fallback: number): number {
  const chosen = usableTimeout(explicit) ?? parseTimeoutMs(envValue) ?? fallback;
  return Math.min(Math.max(1, chosen), MAX_TIMEOUT_MS);
}

function usableTimeout(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

function parseTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return usableTimeout(Number(trimmed));
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
  const timeoutMs = resolveTimeoutMs(options.timeoutMs, env.GROK_TIMEOUT_MS, DEFAULT_CLIENT_TIMEOUT_MS);
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
      if (isClientTimeout(error)) {
        const failure = fail("timeout", "The model call timed out.");
        reportFailure(failure, attempt);
        return failure;
      }
      lastFailure = fail("network", networkMessage());
      reportFailure(lastFailure, attempt);
      continue;
    }

    if (response.ok) {
      const result = await readSuccess(response, args.outputSchema, model);
      if (!result.ok) reportFailure(result, attempt);
      return result;
    }

    const signals = await readErrorSignals(response);
    const category = categoryForStatus(response.status, signals);
    lastFailure = fail(category, httpMessage(category, response.status), response.status);
    reportFailure(lastFailure, attempt);
    if (!isRetryableStatus(response.status)) return lastFailure;
  }

  return lastFailure ?? fail("network", "model request failed");
}

const ERROR_BODY_CAP = 4_096;

type ErrorSignals = {
  credential: boolean;
  quota: boolean;
  schema: boolean;
};

const NO_ERROR_SIGNALS: ErrorSignals = { credential: false, quota: false, schema: false };

function categoryForStatus(status: number, signals: ErrorSignals): GrokErrorCategory {
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "server_error";
  // A credits or spending-limit 403 uses the same status as a rejected key.
  // Check the body first, and leave 429 and 5xx on the retry path.
  if (signals.quota) return "quota_exhausted";
  if (status === 401 || status === 403) return "unauthorized";
  // xAI uses HTTP 400 for a bad key.
  if (signals.credential) return "unauthorized";
  // A rejected JSON schema is also HTTP 400. Only call it a schema error when the body says so.
  if (status === 400 && signals.schema) return "schema";
  return "bad_request";
}

/**
 * Phrases in the error body pick a category. They are not copied into the
 * message shown in the UI: xAI can echo the key, and a credits error can
 * name the team.
 *
 * A bad key is HTTP 400, code "invalid-argument", "Incorrect API key".
 * No credits is HTTP 403, code "permission-denied", with text about used
 * credits or a spending limit. The code alone is not enough for either case.
 */
async function readErrorSignals(response: Response): Promise<ErrorSignals> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return NO_ERROR_SIGNALS;
  }
  if (text.length > ERROR_BODY_CAP) text = text.slice(0, ERROR_BODY_CAP);
  return signalsFromErrorBody(text);
}

function signalsFromErrorBody(text: string): ErrorSignals {
  const blob = collectPhrases(text).join("\n").toLowerCase().replace(/[_-]+/g, " ");
  const quota = looksLikeQuotaFailure(blob);
  const credential = !quota && looksLikeCredentialFailure(blob);
  return {
    credential,
    quota,
    schema: !credential && !quota && looksLikeSchemaFailure(blob),
  };
}

function looksLikeQuotaFailure(blob: string): boolean {
  if (/\bspending limit\b/.test(blob)) return true;
  if (/\b(?:out of credits|no available credits|insufficient credits|credits exhausted|credits depleted)\b/.test(blob)) {
    return true;
  }
  if (/\bused all\b[\s\S]{0,80}\bcredits?\b/.test(blob)) return true;
  return /\bcredits?\b[\s\S]{0,80}\b(?:exhausted|depleted|unavailable)\b/.test(blob);
}

function looksLikeCredentialFailure(blob: string): boolean {
  if (/\b(unauthenticated|unauthorized|permission denied)\b/.test(blob)) return true;
  return /\bapi ?key\b/.test(blob) && /\b(incorrect|invalid|rejected|missing|provided)\b/.test(blob);
}

function looksLikeSchemaFailure(blob: string): boolean {
  return /\b(json schema|response format|invalid schema)\b/.test(blob) || /\bschema\b/.test(blob);
}

function collectPhrases(text: string): string[] {
  const phrases: string[] = [];
  const push = (value: string) => {
    if (phrases.length >= 24 || value.length === 0) return;
    phrases.push(value.slice(0, 300));
  };
  try {
    walkErrorValue(JSON.parse(text) as unknown, 0, push);
  } catch {
    push(text.slice(0, 300));
  }
  return phrases;
}

function walkErrorValue(value: unknown, depth: number, push: (value: string) => void): void {
  if (depth > 4) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) walkErrorValue(item, depth + 1, push);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value).slice(0, 12)) {
      push(key);
      walkErrorValue(child, depth + 1, push);
    }
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function fail(category: GrokErrorCategory, message: string, status?: number): GrokFailure {
  return status === undefined ? { ok: false, category, message } : { ok: false, category, message, status };
}

function httpMessage(category: GrokErrorCategory, status: number): string {
  if (category === "unauthorized") return "The API key was rejected.";
  if (category === "quota_exhausted") return "xAI account has no available credits or hit its spending limit.";
  if (category === "rate_limited") return "model API rate limit exceeded";
  if (category === "server_error") return "model API returned a server error";
  if (category === "schema") return "model API rejected the response schema";
  return `model API rejected the request (${status})`;
}

class ClientTimeoutError extends Error {
  constructor() {
    super("The model call timed out.");
    this.name = "ClientTimeoutError";
  }
}

function isClientTimeout(error: unknown): boolean {
  return error instanceof ClientTimeoutError || (error instanceof Error && error.name === "AbortError");
}

function networkMessage(): string {
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
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new ClientTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
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
  if (content.kind === "truncated") {
    return fail("invalid_response", "The model response was cut off because it reached max_tokens.", response.status);
  }
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
): { kind: "text"; text: string } | { kind: "truncated" } | { kind: "refusal" } | { kind: "missing" } {
  if (typeof payload !== "object" || payload === null) return { kind: "missing" };
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { kind: "missing" };
  const choice = choices[0] as { finish_reason?: unknown; message?: unknown } | undefined;
  if (choice?.finish_reason === "length") return { kind: "truncated" };
  const message = choice?.message;
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
