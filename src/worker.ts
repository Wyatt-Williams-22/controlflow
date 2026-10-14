import "server-only";

import path from "node:path";

import { analyzeControlEvent, type AnalyzeOptions } from "./workflows/analyze-control-event";
import { claimNextQueued, failInterruptedJobs, getDatabase, type AppDatabase } from "./storage/db";

/**
 * Single-process poller. On startup, a job left in selecting_evidence,
 * analyzing, or validating is marked failed with category interrupted.
 * A queued job is claimed and run. Retry creates a new attempt on that job.
 */

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
  const db = getDatabase();
  recoverInterrupted(db);
  console.log("ControlFlow worker started");
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
