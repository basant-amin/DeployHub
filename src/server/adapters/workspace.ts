/**
 * Where a project's source lives on disk.
 *
 * One definition, shared by the two adapters that need it: git checks the source out here, and
 * docker builds here because `dockerfilePath` and `buildContext` are workspace-relative. Two
 * copies of this convention would eventually disagree, and the symptom would be a build that
 * cannot find a Dockerfile that is plainly there.
 */

import { join } from "node:path";

import type { Project } from "@/core/domain";

export interface WorkspaceLayout {
  /** Directory holding one workspace per project. */
  readonly root: string;
}

/** The checkout directory for a project. Keyed by slug, which is stable and path-safe. */
export function workspaceFor(layout: WorkspaceLayout, project: Project): string {
  return join(layout.root, project.slug, "repo");
}
