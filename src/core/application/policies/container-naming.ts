/**
 * Container naming.
 *
 * One convention: a container is named for the deployment that created it, and keeps that
 * name for its whole life. There is no canonical `<slug>` container and nothing is
 * renamed at promotion.
 *
 * That is a deliberate simplification of the flow document's step 28, which renames the
 * candidate to the canonical name and the outgoing container to `<slug>-previous-…`.
 * Renaming reads well but cannot be made collision-free here: the previous container is
 * kept after finalization, so the *next* deployment's rename would land on a name already
 * taken. Identity does not depend on names in any case — the proxy's upstream says which
 * container is live, and labels say which deployment built it, which is exactly how
 * baseline capture and recovery already work.
 *
 * Naming lives in the application layer rather than in the container adapter because the
 * `ContainerRuntime` port takes a `ContainerName`: the caller decides what a container is
 * called, and the adapter decides what labels it carries.
 */

import {
  type ContainerName,
  type DeploymentId,
  type Result,
  ContainerName as ContainerNameCodec,
  DeploymentError,
  err,
} from "@/core/shared";
import type { ProjectSlug } from "@/core/domain";

/**
 * The container a deployment starts, and keeps.
 *
 * Unique by construction, because a deployment id is: two deployments of the same project
 * can therefore be on the host at once, which is precisely what candidate-then-promote
 * requires.
 */
export function deploymentContainerName(
  slug: ProjectSlug,
  deploymentId: DeploymentId,
): Result<ContainerName> {
  const raw = `${slug}-${deploymentId}`;
  const parsed = ContainerNameCodec.parse(raw);
  return parsed.ok
    ? parsed
    : err(
        DeploymentError.of(
          "CONTAINER_NAME_INVALID",
          `Derived container name is not usable: ${raw}`,
          { details: { raw } },
        ),
      );
}
