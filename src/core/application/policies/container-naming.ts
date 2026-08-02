/**
 * Container naming.
 *
 * One convention: a project's container is named for the project, and every deployment
 * replaces it. `one-community` is the container, not `one-community-<deployment id>`.
 *
 * The classic strategy (`docs/architecture/decisions.md` § D12) is what makes this both
 * possible and necessary. Possible, because the previous container is removed before the
 * new one starts, so the name is always free. Necessary, because the whole point is to
 * reproduce the manual `docker stop <name>` / `docker rm <name>` / `docker run --name
 * <name>` workflow, and that workflow is built on a name an operator can type.
 *
 * This supersedes the per-deployment naming the candidate-then-promote design required
 * (D8), where two containers of one project had to coexist and therefore could not share a
 * name. Identity still does not depend on the name: labels record which deployment built a
 * container, which is how baseline capture and the boot sweep recognise it.
 *
 * Naming lives in the application layer rather than in the container adapter because the
 * `ContainerRuntime` port takes a `ContainerName`: the caller decides what a container is
 * called, and the adapter decides what labels it carries.
 */

import {
  type ContainerName,
  type Result,
  ContainerName as ContainerNameCodec,
  DeploymentError,
  err,
} from "@/core/shared";
import type { ProjectSlug } from "@/core/domain";

/**
 * The container a project runs under.
 *
 * Stable across deployments by construction. The slug is already validated as path- and
 * name-safe and is immutable after creation, so this can only fail if the two codecs ever
 * disagree about what a legal name is — which is worth reporting rather than assuming away.
 */
export function projectContainerName(slug: ProjectSlug): Result<ContainerName> {
  const parsed = ContainerNameCodec.parse(slug);
  return parsed.ok
    ? parsed
    : err(
        DeploymentError.of(
          "CONTAINER_NAME_INVALID",
          `Derived container name is not usable: ${slug}`,
          { details: { raw: slug } },
        ),
      );
}
