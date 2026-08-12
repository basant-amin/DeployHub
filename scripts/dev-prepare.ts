/**
 * Prepare this machine to run `npm run dev`.
 *
 * The counterpart of `docs/ops/install.sh` for a developer machine, and the reason `npm run dev`
 * works on a fresh clone: it runs as `predev`, so the startup check finds a prepared root instead
 * of exiting with four problems and a command that expects a server.
 *
 * It is deliberately thin — every decision it appears to make lives in
 * `src/server/runtime/dev-root.ts`, where it can be tested against a temporary directory rather
 * than against the developer's home.
 *
 * Idempotent. On a second run it prints what was already correct and changes nothing.
 */

import { existsSync, readFileSync } from "node:fs";

import {
  DEV_ENV_FILE,
  DevSetupError,
  defaultDevRoot,
  ensureDevEnvFile,
  prepareDevRoot,
  readEnvValue,
} from "@/server/runtime/dev-root";

/**
 * Which root to prepare.
 *
 * The environment wins, so `DEPLOYHUB_ROOT=/tmp/x npm run dev:prepare` is a one-off without
 * editing anything. Otherwise the env file decides, because it is what the dev server will
 * actually read — preparing a different directory from the one Next loads is the whole class of
 * bug this ordering avoids. The home-directory default applies only to a machine with neither.
 */
function resolveRoot(): string {
  const fromEnvironment = process.env.DEPLOYHUB_ROOT?.trim();
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    return fromEnvironment;
  }

  if (existsSync(DEV_ENV_FILE)) {
    const recorded = readEnvValue(readFileSync(DEV_ENV_FILE, "utf8"), "DEPLOYHUB_ROOT");
    if (recorded !== undefined) {
      return recorded;
    }
  }

  return defaultDevRoot();
}

function main(): number {
  const root = resolveRoot();

  const prepared = prepareDevRoot(root);
  const env = ensureDevEnvFile(DEV_ENV_FILE, prepared.root);

  const changed = [
    ...prepared.changed,
    ...(env.created
      ? [`created ${env.path} with a generated local password`]
      : env.added.map((name) => `added ${name} to ${env.path}`)),
  ];
  const already = [
    ...prepared.already,
    ...(env.created ? [] : env.already.map((name) => `${env.path} already sets ${name}`)),
  ];

  if (changed.length === 0) {
    console.log(`DeployHub dev root ready: ${prepared.root}`);
    return 0;
  }

  console.log(`Preparing ${prepared.root} for local development\n`);
  for (const line of changed) {
    console.log(`  changed ${line}`);
  }
  for (const line of already) {
    console.log(`  ok      ${line}`);
  }
  console.log(`\n${changed.length} change(s) made, ${already.length} already correct.`);

  return 0;
}

try {
  process.exitCode = main();
} catch (cause) {
  // A refusal is a message to a person, not a stack trace: the path is wrong and they have to
  // choose a different one. Anything else is a real fault and keeps its stack.
  if (cause instanceof DevSetupError) {
    console.error(`Cannot prepare the local runtime root.\n\n  ${cause.message}\n`);
  } else {
    console.error(cause);
  }
  process.exitCode = 1;
}
