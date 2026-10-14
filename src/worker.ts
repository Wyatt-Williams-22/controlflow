import "server-only";

import path from "node:path";

import { loadEnvConfig } from "@next/env";

import { analyzeControlEvent, analysisModel, type AnalyzeOptions } from "./workflows/analyze-control-event";
import { claimNextQueued, failInterruptedJobs, getDatabase, type AppDatabase } from "./storage/db";

/**
 * Single-process poller. On startup, a job left in selecting_evidence,
 * analyzing, or validating is marked failed with category interrupted.
 * A queued job is claimed and run. Retry creates a new attempt on that job.
 *
 * Env files are loaded the same way Next does. A variable already set in
 * the shell is left alone. The startup line names the model and says
 * whether XAI_API_KEY is present. It does not print the key.
 */

/** Development matches `next dev` when NODE_ENV is unset. Production matches `next start`. */
export function loadWorkerEnv(dir = process.cwd()): void {
  const dev = process.env.NODE_ENV !== "production";
  loadEnvConfig(dir, dev);
}

export function workerStartupLine(): string {
  const model = analysisModel({});
  const key = (process.env.XAI_API_KEY ?? "").trim().length > 0 ? "yes" : "no";
  return `ControlFlow worker started model=${model} key=${key}`;
}

const POLL_MS = 500;

export async function pollOnce(db: AppDatabase, options: AnalyzeOptions = {}): Promise<boolean> {
  const job = claimNextQueued(db);
  if (!job) return false;
  await analyzeControlEvent(db, job.id, options);
  return true;
}

export function recoverInterrupted(db: AppDatabase): string[] {
  return failInterruptedJobs(db);
}

async function main(): Promise<void> {
  loadWorkerEnv();
  const db = getDatabase();
  recoverInterrupted(db);
  console.log(workerStartupLine());
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopped) {
    const ran = await pollOnce(db);
    if (!ran) await sleep(POLL_MS);
  }
  db.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const entry = process.argv[1] ?? "";
if (entry.endsWith(`${path.sep}worker.ts`) || entry.endsWith(`${path.sep}worker.js`)) {
  void main();
}
