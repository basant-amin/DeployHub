/**
 * A CLI, so the platform can be proved before there is any dashboard.
 *
 * Four commands:
 *
 *   register <file.json>   store a project from a JSON config
 *   deploy <slug> [ref]    queue a deployment and run the worker until it finishes
 *   rollback <slug>        queue a rollback to the release before the live one
 *   show <slug>            print the project overview and its deployment history
 *
 * It is deliberately thin: it constructs the platform, calls a use case, runs the worker, and
 * prints. Every decision it appears to make is really the engine's.
 */

import { readFileSync } from "node:fs";

import {
  type ProjectId,
  type Result,
  Actor,
  DeploymentId,
  GitRef,
  IdempotencyKey,
  unwrapOrThrow,
} from "@/core/shared";
import { Project } from "@/core/domain";

import { runBootSweep } from "@/server/runtime/boot-sweep";
import { createPlatform, runtimeConfigFromEnv, type Platform } from "@/server/runtime/composition";
import { Worker } from "@/server/runtime/worker";

const actor = unwrapOrThrow(Actor.parse(process.env.DEPLOYHUB_ACTOR ?? "cli@deployhub"));

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  const platform = createPlatform(runtimeConfigFromEnv());

  try {
    // Recover anything a dead worker left behind *before* doing anything else. "Boot" means
    // process start: running it later would let admission be refused by a deployment whose
    // worker is already gone.
    const swept = await runBootSweep(platform);
    if (swept.ok && swept.value.recovered.length > 0) {
      console.log(
        `recovered ${swept.value.recovered.length} abandoned deployment(s), ` +
          `released ${swept.value.leasesReleased} lease(s), ` +
          `removed ${swept.value.containersRemoved} container(s)`,
      );
    }

    switch (command) {
      case "register":
        return await register(platform, args[0]);
      case "deploy":
        return await deploy(platform, args[0], args[1]);
      case "rollback":
        return await rollback(platform, args[0]);
      case "show":
        return await show(platform, args[0]);
      default:
        console.error("usage: deployhub <register|deploy|rollback|show> …");
        return 2;
    }
  } finally {
    platform.close();
  }
}

async function register(platform: Platform, path: string | undefined): Promise<number> {
  if (path === undefined) {
    console.error("register needs a path to a project JSON file");
    return 2;
  }
  const project = Project.create(JSON.parse(readFileSync(path, "utf8")));
  if (!project.ok) {
    return fail("the project configuration is not valid", project);
  }
  const saved = await platform.projects.save(project.value);
  if (!saved.ok) {
    return fail("the project could not be saved", saved);
  }
  console.log(`registered ${project.value.slug} → ${project.value.config.route.toString()}`);
  return 0;
}

async function deploy(
  platform: Platform,
  slug: string | undefined,
  ref: string | undefined,
): Promise<number> {
  const project = await findProject(platform, slug);
  if (project === undefined) {
    return 2;
  }

  const requested = await platform.requestDeployment.execute({
    projectId: project,
    actor,
    idempotencyKey: freshKey(),
    ...(ref === undefined ? {} : { targetRef: unwrapOrThrow(GitRef.parse(ref)) }),
  });
  if (!requested.ok) {
    return fail("the deployment was refused", requested);
  }
  console.log(`queued ${requested.value.deployment.id}`);

  return runUntilFinished(platform, requested.value.deployment.id);
}

async function rollback(platform: Platform, slug: string | undefined): Promise<number> {
  const project = await findProject(platform, slug);
  if (project === undefined) {
    return 2;
  }

  // The release before the live one — which is what "roll back" means with no argument.
  const releases = await platform.releases.listForProject(project, 5);
  if (!releases.ok) {
    return fail("could not read the release history", releases);
  }
  const target = releases.value[1];
  if (target === undefined) {
    console.error("there is no earlier release to roll back to");
    return 2;
  }

  const requested = await platform.requestRollback.execute({
    projectId: project,
    releaseId: target.id,
    actor,
    idempotencyKey: freshKey(),
  });
  if (!requested.ok) {
    return fail("the rollback was refused", requested);
  }
  console.log(`queued rollback ${requested.value.id} → ${target.commitSha.slice(0, 7)}`);

  return runUntilFinished(platform, requested.value.id);
}

async function show(platform: Platform, slug: string | undefined): Promise<number> {
  const project = await findProject(platform, slug);
  if (project === undefined) {
    return 2;
  }
  const history = await platform.getDeploymentHistory.execute({ projectId: project, limit: 10 });
  if (!history.ok) {
    return fail("could not read the history", history);
  }

  const overview = history.value.project;
  console.log(`\n${overview.name}  ${overview.route}`);
  console.log(
    `live: ${overview.liveCommitSha?.slice(0, 7) ?? "nothing"}` +
      `${overview.activeDeploymentId === undefined ? "" : `  (deploying ${overview.activeDeploymentId})`}`,
  );
  console.log("");
  for (const deployment of history.value.deployments) {
    const duration =
      deployment.durationMillis === undefined
        ? "—"
        : `${Math.round(deployment.durationMillis / 100) / 10}s`;
    console.log(
      [
        deployment.state.padEnd(16),
        (deployment.commitSha ?? deployment.targetRef).slice(0, 7).padEnd(8),
        deployment.trigger.padEnd(9),
        duration.padStart(7),
        deployment.errorCode ?? "",
      ].join("  "),
    );
  }
  console.log("");
  return 0;
}

/** Run the worker until the given deployment reaches a terminal state, then report. */
async function runUntilFinished(platform: Platform, deploymentId: string): Promise<number> {
  const worker = new Worker(platform, { idlePollMillis: 200, maxDeployments: 1 }, (message) =>
    console.log(`  ${message}`),
  );
  const ran = await worker.run();
  if (!ran.ok) {
    return fail("the worker stopped", ran);
  }

  const detail = await platform.getDeploymentDetail.execute({
    deploymentId: unwrapOrThrow(DeploymentId.parse(deploymentId)),
  });
  if (!detail.ok) {
    return fail("could not read the deployment", detail);
  }

  console.log("");
  for (const line of detail.value.logs) {
    console.log(`  ${new Date(line.at).toISOString().slice(11, 19)}  ${line.text}`);
  }
  console.log("");
  console.log(`state:   ${detail.value.state}`);
  if (detail.value.commitSha !== undefined) {
    console.log(`commit:  ${detail.value.commitSha.slice(0, 7)}`);
  }
  if (detail.value.errorCode !== undefined) {
    console.log(`error:   ${detail.value.errorCode} — ${detail.value.errorMessage ?? ""}`);
  }
  for (const warning of detail.value.warnings) {
    console.log(`warning: ${warning.code} — ${warning.message}`);
  }

  // Anything that did not ship is a non-zero exit, so a script can tell.
  return detail.value.state === "succeeded" ? 0 : 1;
}

async function findProject(
  platform: Platform,
  slug: string | undefined,
): Promise<ProjectId | undefined> {
  if (slug === undefined) {
    console.error("this command needs a project slug");
    return undefined;
  }
  const projects = await platform.projects.list();
  if (!projects.ok) {
    fail("could not read projects", projects);
    return undefined;
  }
  const found = projects.value.find((project) => project.slug === slug || project.id === slug);
  if (found === undefined) {
    console.error(`no project "${slug}" is registered`);
    return undefined;
  }
  return found.id;
}

function freshKey(): IdempotencyKey {
  return unwrapOrThrow(
    IdempotencyKey.parse(`cli-${Date.now()}-${Math.floor(Math.random() * 100_000)}`),
  );
}

function fail(what: string, result: Result<unknown>): number {
  if (!result.ok) {
    console.error(`${what}: ${result.error.code} — ${result.error.message}`);
    for (const issue of result.error.issues) {
      console.error(`  · ${issue}`);
    }
  }
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    console.error(cause);
    process.exitCode = 1;
  });
