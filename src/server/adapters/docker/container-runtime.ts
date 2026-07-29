/**
 * `ContainerRuntime` over the Docker CLI.
 *
 * Every command was verified against a real daemon — see `docs/ops/host-spike.md`.
 *
 * Two rules this file follows without exception:
 *
 * **All structured data comes from `docker inspect`.** `docker container ls` is used only with
 * `-q`, which emits bare ids with no columns, and every id is then inspected. There is no
 * column parsing anywhere, because `docker ps` output is a human interface that changes.
 *
 * **The host allocates the port.** A candidate is published with an empty host port on
 * loopback, so Docker chooses a free one and the adapter reports back what it actually bound.
 * Asking a caller to pick a port invites a collision the caller cannot see, and binding to
 * loopback means a candidate is unreachable from outside until the proxy is pointed at it.
 */

import {
  type ContainerId,
  type ContainerName,
  type Duration,
  type ImageDigest,
  type ImageReference,
  type Result,
  CommitSha as CommitShaCodec,
  ContainerId as ContainerIdCodec,
  ContainerName as ContainerNameCodec,
  DeploymentError,
  DeploymentId as DeploymentIdCodec,
  ImageDigest as ImageDigestCodec,
  ImageReference as ImageReferenceCodec,
  err,
  ok,
} from "@/core/shared";
import { type Project, ProxyUpstream } from "@/core/domain";
import type {
  BuiltImage,
  ContainerRuntime,
  ContainerSnapshot,
  ContainerStartRequest,
  ContainerState,
  ImageBuildRequest,
  StorageHeadroom,
} from "@/core/ports";

import { type CommandRunner, commandFailure } from "../command-runner";
import { type WorkspaceLayout, workspaceFor } from "../workspace";

const LABEL = {
  project: "deployhub.project",
  deployment: "deployhub.deployment",
  commit: "deployhub.commit",
  digest: "deployhub.digest",
  actor: "deployhub.actor",
} as const;

const BUILD_TIMEOUT_MILLIS = 1_800_000;
const DOCKER_TIMEOUT_MILLIS = 120_000;

export interface DockerAdapterOptions extends WorkspaceLayout {
  /** The address a container is published on, and therefore probed at. */
  readonly bindHost: string;
  /** Filesystem whose free space is reported. Docker's data root on the target. */
  readonly storagePath: string;
}

/** The subset of `docker inspect` this adapter reads. Everything else is ignored. */
interface DockerInspect {
  readonly Id?: string;
  readonly Name?: string;
  readonly Image?: string;
  readonly RestartCount?: number;
  readonly State?: {
    readonly Status?: string;
    readonly ExitCode?: number;
    readonly Restarting?: boolean;
  };
  readonly Config?: {
    readonly Image?: string;
    readonly Labels?: Record<string, string>;
  };
  readonly NetworkSettings?: {
    readonly Ports?: Record<
      string,
      readonly { readonly HostIp?: string; readonly HostPort?: string }[] | null
    >;
  };
}

export class DockerContainerRuntime implements ContainerRuntime {
  constructor(
    private readonly runner: CommandRunner,
    private readonly options: DockerAdapterOptions,
  ) {}

  async buildImage(request: ImageBuildRequest): Promise<Result<BuiltImage>> {
    const config = request.project.config;
    const reference = ImageReferenceCodec.parse(`${config.imageRepository}:${request.commitSha}`);
    if (!reference.ok) {
      return reference;
    }

    const args = [
      "build",
      "--quiet",
      "--file",
      config.dockerfilePath,
      "--tag",
      reference.value.toString(),
      "--label",
      `${LABEL.project}=${request.project.slug}`,
      "--label",
      `${LABEL.deployment}=${request.deploymentId}`,
      "--label",
      `${LABEL.commit}=${request.commitSha}`,
      "--label",
      `${LABEL.actor}=${request.actor}`,
    ];
    for (const name of Object.keys(config.buildArgs.entries).sort()) {
      args.push("--build-arg", `${name}=${config.buildArgs.get(name) ?? ""}`);
    }
    args.push(config.buildContext);

    // `dockerfilePath` and `buildContext` are workspace-relative, so the build must run from the
    // workspace — not from wherever the worker process happens to have been started.
    const built = await this.docker(args, BUILD_TIMEOUT_MILLIS, "BUILD_FAILED", {
      cwd: workspaceFor(this.options, request.project),
    });
    if (!built.ok) {
      return built;
    }

    const digest = await this.imageDigest(reference.value);
    return digest.ok ? ok({ reference: reference.value, digest: digest.value }) : digest;
  }

  async startContainer(request: ContainerStartRequest): Promise<Result<ContainerSnapshot>> {
    const args = [
      "run",
      "--detach",
      "--name",
      request.name,
      "--restart",
      "unless-stopped",
      "--label",
      `${LABEL.project}=${request.project.slug}`,
      "--label",
      `${LABEL.deployment}=${request.deploymentId}`,
      "--label",
      `${LABEL.commit}=${request.commitSha}`,
      "--label",
      `${LABEL.digest}=${request.imageDigest}`,
    ];
    for (const [name, value] of [...request.environment].sort(([a], [b]) => a.localeCompare(b))) {
      args.push("--env", `${name}=${value}`);
    }
    // Empty host port: Docker allocates, and only loopback is bound.
    args.push(
      "--publish",
      `${this.options.bindHost}::${request.project.config.containerPort}`,
      // Run the digest, not the tag: a tag can be reassigned, a digest cannot, and this is
      // what lets recovery restart a previous release whose container was destroyed.
      request.imageDigest,
    );

    const started = await this.docker(args, DOCKER_TIMEOUT_MILLIS, "CONTAINER_START_FAILED");
    if (!started.ok) {
      return started;
    }

    const id = ContainerIdCodec.parse(started.value.trim().slice(0, 64));
    if (!id.ok) {
      return id;
    }
    const snapshot = await this.inspect(id.value);
    if (!snapshot.ok) {
      return snapshot;
    }
    if (snapshot.value === undefined) {
      return err(
        DeploymentError.of(
          "CONTAINER_START_FAILED",
          "the container disappeared immediately after being started",
        ),
      );
    }
    return ok(snapshot.value);
  }

  async inspect(id: ContainerId): Promise<Result<ContainerSnapshot | undefined>> {
    const inspected = await this.dockerAllowingMissing(
      ["inspect", id, "--format", "{{json .}}"],
      DOCKER_TIMEOUT_MILLIS,
      "DOCKER_UNAVAILABLE",
    );
    if (!inspected.ok) {
      return inspected;
    }
    if (inspected.value === undefined) {
      return ok(undefined);
    }
    return this.toSnapshot(inspected.value);
  }

  async findForProject(project: Project): Promise<Result<readonly ContainerSnapshot[]>> {
    // `-q` emits ids only — nothing here parses columns.
    const listed = await this.docker(
      ["container", "ls", "-aq", "--filter", `label=${LABEL.project}=${project.slug}`],
      DOCKER_TIMEOUT_MILLIS,
      "DOCKER_UNAVAILABLE",
    );
    if (!listed.ok) {
      return listed;
    }

    const snapshots: ContainerSnapshot[] = [];
    for (const line of listed.value.split("\n")) {
      const raw = line.trim();
      if (raw === "") {
        continue;
      }
      const id = ContainerIdCodec.parse(raw);
      if (!id.ok) {
        continue;
      }
      const snapshot = await this.inspect(id.value);
      // A container removed between listing and inspecting is not an error; it is simply not
      // there any more, and the caller wanted what is there now.
      if (snapshot.ok && snapshot.value !== undefined) {
        snapshots.push(snapshot.value);
      }
    }
    return ok(snapshots);
  }

  async rename(id: ContainerId, name: ContainerName): Promise<Result<void>> {
    const renamed = await this.docker(
      ["rename", id, name],
      DOCKER_TIMEOUT_MILLIS,
      "DOCKER_UNAVAILABLE",
    );
    return renamed.ok ? ok(undefined) : renamed;
  }

  async stop(id: ContainerId, grace: Duration): Promise<Result<void>> {
    const seconds = Math.max(1, Math.round(grace.millis / 1000));
    const stopped = await this.docker(
      ["stop", "--timeout", String(seconds), id],
      DOCKER_TIMEOUT_MILLIS + grace.millis,
      "DOCKER_UNAVAILABLE",
    );
    return stopped.ok ? ok(undefined) : stopped;
  }

  async remove(id: ContainerId): Promise<Result<void>> {
    const removed = await this.dockerAllowingMissing(
      ["rm", "--force", id],
      DOCKER_TIMEOUT_MILLIS,
      "DOCKER_UNAVAILABLE",
    );
    return removed.ok ? ok(undefined) : removed;
  }

  async readLogs(id: ContainerId, maxLines: number): Promise<Result<readonly string[]>> {
    // stderr and stdout are interleaved by docker; both matter when diagnosing a crash.
    const logs = await this.dockerAllowingMissing(
      ["logs", "--tail", String(maxLines), id],
      DOCKER_TIMEOUT_MILLIS,
      "DOCKER_UNAVAILABLE",
      { captureStderr: true },
    );
    if (!logs.ok) {
      return logs;
    }
    const text = logs.value ?? "";
    return ok(text === "" ? [] : text.split("\n").slice(-maxLines));
  }

  async removeImages(digests: readonly ImageDigest[]): Promise<Result<void>> {
    for (const digest of digests) {
      // An image still referenced by a running container cannot be removed, and that is a
      // warning rather than a failure — the retention policy will offer it again next time.
      await this.dockerAllowingMissing(
        ["image", "rm", digest],
        DOCKER_TIMEOUT_MILLIS,
        "DOCKER_UNAVAILABLE",
      );
    }
    return ok(undefined);
  }

  async readStorageHeadroom(): Promise<Result<StorageHeadroom>> {
    // Doubles as the daemon reachability check for preflight: if the daemon is down, this is
    // the call that says so.
    const version = await this.docker(
      ["version", "--format", "{{.Server.Version}}"],
      DOCKER_TIMEOUT_MILLIS,
      "DOCKER_UNAVAILABLE",
    );
    if (!version.ok) {
      return version;
    }

    // `-P` forces one line per filesystem, `-k` forces 1024-byte blocks: the POSIX form.
    const disk = await this.runner.run({
      command: "df",
      args: ["-Pk", this.options.storagePath],
      timeoutMillis: DOCKER_TIMEOUT_MILLIS,
    });
    if (!disk.ok) {
      return disk;
    }
    const row = disk.value.stdout.trim().split("\n").at(-1) ?? "";
    const columns = row.split(/\s+/);
    const totalKib = Number(columns[1]);
    const availableKib = Number(columns[3]);
    if (!Number.isFinite(totalKib) || !Number.isFinite(availableKib)) {
      return err(
        DeploymentError.of(
          "COMMAND_FAILED",
          `Could not read free space for ${this.options.storagePath} from: ${row}`,
        ),
      );
    }
    return ok({ freeBytes: availableKib * 1024, totalBytes: totalKib * 1024 });
  }

  /**
   * The digest of a locally built image is its `Id`.
   *
   * `RepoDigests` is populated only for images that came from or went to a registry, and
   * DeployHub builds on the host it deploys to. `Id` is the sha256 of the image config, which
   * is a content address and satisfies the domain's `ImageDigest` shape.
   */
  private async imageDigest(reference: ImageReference): Promise<Result<ImageDigest>> {
    const inspected = await this.docker(
      ["image", "inspect", reference.toString(), "--format", "{{.Id}}"],
      DOCKER_TIMEOUT_MILLIS,
      "DOCKER_UNAVAILABLE",
    );
    return inspected.ok ? ImageDigestCodec.parse(inspected.value.trim()) : inspected;
  }

  private toSnapshot(json: string): Result<ContainerSnapshot | undefined> {
    let inspected: DockerInspect;
    try {
      inspected = JSON.parse(json) as DockerInspect;
    } catch {
      return err(DeploymentError.of("DOCKER_UNAVAILABLE", "docker inspect did not return JSON"));
    }

    const labels = inspected.Config?.Labels ?? {};
    const containerId = ContainerIdCodec.parse(inspected.Id ?? "");
    const name = ContainerNameCodec.parse((inspected.Name ?? "").replace(/^\//, ""));
    const image = ImageReferenceCodec.parse(inspected.Config?.Image ?? "");
    const digest = ImageDigestCodec.parse(labels[LABEL.digest] ?? inspected.Image ?? "");
    const commitSha = CommitShaCodec.parse(labels[LABEL.commit] ?? "");
    const deploymentId = DeploymentIdCodec.parse(labels[LABEL.deployment] ?? "");

    // A container this platform did not create, or one whose labels have been tampered with,
    // is reported as absent rather than as a malformed snapshot: the caller asked for
    // DeployHub's containers.
    if (
      !containerId.ok ||
      !name.ok ||
      !image.ok ||
      !digest.ok ||
      !commitSha.ok ||
      !deploymentId.ok
    ) {
      return ok(undefined);
    }

    return ok({
      id: containerId.value,
      name: name.value,
      state: toState(inspected),
      image: image.value,
      imageDigest: digest.value,
      commitSha: commitSha.value,
      deploymentId: deploymentId.value,
      upstream: this.toUpstream(inspected),
    });
  }

  private toUpstream(inspected: DockerInspect): ProxyUpstream | undefined {
    const ports = inspected.NetworkSettings?.Ports ?? {};
    for (const bindings of Object.values(ports)) {
      const binding = bindings?.[0];
      if (binding?.HostPort === undefined) {
        continue;
      }
      const upstream = ProxyUpstream.create({
        host: this.options.bindHost,
        port: Number(binding.HostPort),
      });
      if (upstream.ok) {
        return upstream.value;
      }
    }
    return undefined;
  }

  /** Run docker; a non-zero exit is an error. */
  private async docker(
    args: readonly string[],
    timeoutMillis: number,
    failureCode: Parameters<typeof DeploymentError.of>[0],
    options: { captureStderr?: boolean; cwd?: string } = {},
  ): Promise<Result<string>> {
    const request = {
      command: "docker",
      args,
      timeoutMillis,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    };
    const result = await this.runner.run(request);
    if (!result.ok) {
      return result;
    }
    if (result.value.exitCode !== 0) {
      return err(commandFailure(request, result.value, failureCode));
    }
    return ok(
      options.captureStderr === true
        ? `${result.value.stdout}${result.value.stderr}`.trim()
        : result.value.stdout,
    );
  }

  /**
   * Run docker where the object may legitimately be gone — `inspect`, `rm`, and `logs` are all
   * called on things another process may have removed a moment earlier. Absence resolves to
   * `undefined`; anything else is still an error.
   */
  private async dockerAllowingMissing(
    args: readonly string[],
    timeoutMillis: number,
    failureCode: Parameters<typeof DeploymentError.of>[0],
    options: { captureStderr?: boolean } = {},
  ): Promise<Result<string | undefined>> {
    const request = { command: "docker", args, timeoutMillis };
    const result = await this.runner.run(request);
    if (!result.ok) {
      return result;
    }
    if (result.value.exitCode === 0) {
      return ok(
        options.captureStderr === true
          ? `${result.value.stdout}${result.value.stderr}`.trim()
          : result.value.stdout,
      );
    }
    if (isMissing(result.value.stderr)) {
      return ok(undefined);
    }
    return err(commandFailure(request, result.value, failureCode));
  }
}

function toState(inspected: DockerInspect): ContainerState {
  const state = inspected.State ?? {};
  const status = state.Status ?? "";
  if (state.Restarting === true || status === "restarting") {
    return { kind: "restarting", restarts: inspected.RestartCount ?? 0 };
  }
  switch (status) {
    case "created":
      return { kind: "starting" };
    case "running":
      return { kind: "running" };
    case "exited":
    case "dead":
      return { kind: "exited", exitCode: state.ExitCode ?? 0 };
    default:
      // `paused`, `removing`, and anything a future daemon adds: not running, not crashed.
      return { kind: "stopped" };
  }
}

function isMissing(stderr: string): boolean {
  const message = stderr.toLowerCase();
  return message.includes("no such") || message.includes("not found");
}
