import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_GROK_MODEL } from "../src/integrations/grok";
import { loadWorkerEnv, workerStartupLine } from "../src/worker";

describe("worker env", () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    GROK_MODEL: process.env.GROK_MODEL,
    XAI_API_KEY: process.env.XAI_API_KEY,
  };

  afterEach(() => {
    restore("NODE_ENV", saved.NODE_ENV);
    restore("GROK_MODEL", saved.GROK_MODEL);
    restore("XAI_API_KEY", saved.XAI_API_KEY);
    delete process.env.FROM_LOCAL;
    delete process.env.FROM_DOTENV;
  });

  it("logs the configured model and whether a key is present, never the key", () => {
    delete process.env.GROK_MODEL;
    delete process.env.XAI_API_KEY;
    expect(workerStartupLine()).toBe(`ControlFlow worker started model=${DEFAULT_GROK_MODEL} key=no`);

    process.env.XAI_API_KEY = "   ";
    expect(workerStartupLine()).toBe(`ControlFlow worker started model=${DEFAULT_GROK_MODEL} key=no`);

    process.env.GROK_MODEL = "from-shell";
    process.env.XAI_API_KEY = "local-secret";
    const line = workerStartupLine();
    expect(line).toBe("ControlFlow worker started model=from-shell key=yes");
    expect(line).not.toContain("local-secret");
  });

  it("loads .env.local over .env and does not override the shell", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "controlflow-env-"));
    fs.writeFileSync(
      path.join(dir, ".env"),
      "GROK_MODEL=from-dotenv\nXAI_API_KEY=dotenv-secret\nFROM_DOTENV=dotenv-only\n",
    );
    fs.writeFileSync(
      path.join(dir, ".env.local"),
      "GROK_MODEL=from-local\nXAI_API_KEY=local-secret\nFROM_LOCAL=local-only\n",
    );
    setEnv("NODE_ENV", undefined);
    process.env.GROK_MODEL = "from-shell";
    delete process.env.XAI_API_KEY;

    try {
      loadWorkerEnv(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    expect(process.env.GROK_MODEL).toBe("from-shell");
    expect(process.env.XAI_API_KEY).toBe("local-secret");
    expect(process.env.FROM_LOCAL).toBe("local-only");
    expect(process.env.FROM_DOTENV).toBe("dotenv-only");
    const line = workerStartupLine();
    expect(line).toBe("ControlFlow worker started model=from-shell key=yes");
    expect(line).not.toContain("local-secret");
    expect(line).not.toContain("dotenv-secret");
  });
});

function restore(key: "NODE_ENV" | "GROK_MODEL" | "XAI_API_KEY", value: string | undefined): void {
  setEnv(key, value);
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
