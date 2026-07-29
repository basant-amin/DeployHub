/**
 * Container value objects.
 *
 * These describe containers without describing Docker. A `ContainerId` is an opaque
 * runtime handle and a `ContainerName` is a label the runtime accepts — both are
 * concepts a Kubernetes adapter satisfies just as well, which is why they live in
 * the shared kernel rather than being Docker types leaked upward.
 */

import type { Brand } from "./brand";
import { type Codec, brandedInteger, brandedString } from "./codec";

/** A runtime-assigned container identifier: 12–64 lowercase hex characters. */
export type ContainerId = Brand<string, "ContainerId">;

export const ContainerId: Codec<ContainerId> = brandedString<ContainerId>({
  label: "Container id",
  code: "CONTAINER_ID_INVALID",
  minLength: 12,
  maxLength: 64,
  lowercase: true,
  pattern: /^[0-9a-f]+$/,
  patternHint: "be 12 to 64 hexadecimal characters",
});

/** A container name the runtime will accept. */
export type ContainerName = Brand<string, "ContainerName">;

export const ContainerName: Codec<ContainerName> = brandedString<ContainerName>({
  label: "Container name",
  code: "CONTAINER_NAME_INVALID",
  minLength: 2,
  maxLength: 128,
  pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
  patternHint:
    "start with a letter or digit and contain only letters, digits, underscores, periods, and hyphens",
});

/** A TCP port a container listens on. */
export type ContainerPort = Brand<number, "ContainerPort">;

export const ContainerPort: Codec<ContainerPort> = brandedInteger<ContainerPort>({
  label: "Container port",
  code: "CONTAINER_PORT_INVALID",
  min: 1,
  max: 65535,
});
