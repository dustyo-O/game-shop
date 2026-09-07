#!/usr/bin/env node
/**
 * Runs a command with the repository's local environment loaded.
 *
 * Local development only — Vercel injects its own environment and nothing here
 * runs inside the deployed function. Every root `pnpm` script that touches the
 * database, the API or the web dev server goes through this wrapper so all of
 * them see one environment, assembled the same way.
 *
 * Precedence, lowest to highest:
 *   1. `.env.example` — committed local defaults, so a fresh clone starts with
 *      no setup step.
 *   2. `.env`         — the developer's overrides (gitignored, may be absent).
 *   3. the real process environment — anything already exported wins, which is
 *      how CI and one-off runs override without editing a file.
 *
 * Run directly by Node's type stripping (`node scripts/with-env.ts`), which is
 * on by default from Node 22.18 — hence the engines floor in package.json. No
 * build step: this wrapper is what launches the builds.
 *
 * Usage: node scripts/with-env.ts <command> [args...]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXIT_USAGE = 2;
const EXIT_COMMAND_NOT_RUNNABLE = 127;

/**
 * Minimal KEY=value reader. Deliberately not a dotenv clone: no inline
 * comments, no interpolation, no multi-line values. Anything needing more than
 * that belongs in a config file, not in the environment.
 */
function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};

  const parsed: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).replace(/^export\s+/, "").trim();
    if (key === "") continue;

    let value = line.slice(separator + 1).trim();
    const isQuoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (isQuoted) value = value.slice(1, -1);

    parsed[key] = value;
  }
  return parsed;
}

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error("with-env: usage: node scripts/with-env.ts <command> [args...]");
  process.exit(EXIT_USAGE);
}

const env: NodeJS.ProcessEnv = {
  ...readEnvFile(resolve(repoRoot, ".env.example")),
  ...readEnvFile(resolve(repoRoot, ".env")),
  ...process.env,
};

const child = spawn(command, args, { cwd: repoRoot, env, stdio: "inherit" });

child.on("error", (error: Error) => {
  console.error(`with-env: could not run "${command}": ${error.message}`);
  process.exit(EXIT_COMMAND_NOT_RUNNABLE);
});

child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
  // Signals are re-raised rather than translated, so Ctrl-C on `pnpm dev` still
  // looks like an interrupt to whatever launched pnpm.
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
