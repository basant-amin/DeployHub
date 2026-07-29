/**
 * `GitClient` — get a project's source to a specific commit.
 *
 * Git is a first-class concept in this architecture, not a leaked vendor detail: the
 * scope statement names Git as the source of truth, and the domain models a `GitRef`
 * and a `CommitSha` as distinct types. What must not leak is the *command line* —
 * there is no `fetch`, no `--prune`, and no notion of a working tree here.
 *
 * The single method reflects the deployment flow's one requirement of source control:
 * *put the workspace at this ref and tell me exactly which commit that turned out to
 * be*. Ensuring the workspace exists, cloning on first use, discarding local changes,
 * and resolving the ref are steps in service of that answer, and splitting them into
 * separate calls would only let a caller perform three of the four.
 *
 * Returning the resolved sha is the point. A branch is a moving pointer; everything
 * downstream — the build, the image tag, the release record — takes the sha, so a push
 * landing mid-deployment cannot change what ships
 * (`docs/architecture/decisions.md` § D4).
 */

import type { CommitSha, GitRef, Result } from "@/core/shared";
import type { Project } from "@/core/domain";

export interface GitClient {
  /**
   * Place the project's source at `ref` and return the commit it resolved to.
   *
   * Fails when the ref does not exist on the remote, when the credential is rejected,
   * or when the remote is unreachable — three outcomes the engine treats differently,
   * so they arrive as distinct error codes rather than one.
   */
  checkOut(project: Project, ref: GitRef): Promise<Result<CommitSha>>;
}
