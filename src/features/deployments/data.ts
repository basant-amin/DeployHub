import "server-only";

/**
 * The read path for every screen.
 *
 * Pages call these; they never touch a repository or an adapter. Each returns a discriminated
 * union rather than throwing, so a page renders an honest state instead of a Next.js error
 * overlay — "no project registered yet" and "the store is unreachable" are different situations
 * and the UI treats them differently.
 *
 * Release 1 has one project, so "the project" is the first one registered. When a second exists,
 * these gain a slug parameter and nothing else changes.
 */

import { type DeploymentId, DeploymentId as DeploymentIdCodec } from "@/core/shared";
import type { DeploymentDetail, DeploymentHistory, DeploymentSummary } from "@/core/application";
import { getPlatform } from "@/server/runtime/platform";

export type ProductionView =
  | { readonly kind: "ready"; readonly history: DeploymentHistory }
  /** Nothing registered yet — the first-run path. */
  | { readonly kind: "unconfigured" }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

export async function loadProduction(limit = 5): Promise<ProductionView> {
  const platform = getPlatform();

  const projects = await platform.projects.list();
  if (!projects.ok) {
    return { kind: "error", code: projects.error.code, message: projects.error.message };
  }
  const project = projects.value[0];
  if (project === undefined) {
    return { kind: "unconfigured" };
  }

  const history = await platform.getDeploymentHistory.execute({ projectId: project.id, limit });
  return history.ok
    ? { kind: "ready", history: history.value }
    : { kind: "error", code: history.error.code, message: history.error.message };
}

export type HistoryView =
  | { readonly kind: "ready"; readonly deployments: readonly DeploymentSummary[] }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

export async function loadHistory(limit = 50): Promise<HistoryView> {
  const production = await loadProduction(limit);
  if (production.kind !== "ready") {
    return production;
  }
  return { kind: "ready", deployments: production.history.deployments };
}

export type DetailView =
  | { readonly kind: "ready"; readonly detail: DeploymentDetail }
  | { readonly kind: "not-found" }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

export async function loadDeployment(rawId: string): Promise<DetailView> {
  const id = DeploymentIdCodec.parse(rawId);
  if (!id.ok) {
    // A malformed id in the URL is indistinguishable from a deleted one, as far as the reader is
    // concerned: there is nothing here.
    return { kind: "not-found" };
  }

  const detail = await getPlatform().getDeploymentDetail.execute({
    deploymentId: id.value satisfies DeploymentId,
  });
  if (detail.ok) {
    return { kind: "ready", detail: detail.value };
  }
  return detail.error.code === "DEPLOYMENT_NOT_FOUND"
    ? { kind: "not-found" }
    : { kind: "error", code: detail.error.code, message: detail.error.message };
}
