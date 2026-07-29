/**
 * The deployment engine.
 *
 * One entry point — `run` — that takes a queued deployment and returns a terminal one. It
 * is written as a straight line, in the order of `docs/architecture/deployment-flow.md`,
 * because that is the form in which it can be read against the document it implements.
 *
 * There is no step-pipeline framework, and that is a deliberate narrowing of § D2. A
 * generic runner with per-step compensation earns its keep when steps are many and their
 * compensations vary. This flow has eleven steps and exactly **two** compensations —
 * discard the candidate, or put the previous release back — and which applies depends on
 * one fact: whether traffic has been switched. A reverse-unwinding stack would be a
 * mechanism built for a case that does not exist. Step *records* are kept, because the
 * domain and the timeline view are built on them.
 *
 * Also absent, per MVP scope: retries, cancellation, and event publishing. A failure is
 * reported and the operator decides.
 *
 * The engine performs no I/O of its own — everything goes through a port, which is why
 * every path through it, including both compensations, is testable in memory.
 */

import {
  type ContainerId,
  type ErrorCode,
  type ImageDigest,
  type ProjectId,
  type Result,
  type Timestamp,
  DeploymentError,
  type Duration,
  Redactor,
  err,
  ok,
} from "@/core/shared";
import {
  type Baseline,
  type ExistingBaseline,
  type HealthCheckSpec,
  type Project,
  type StepName,
  Baselines,
  CandidateContainer,
  Deployment,
  DeploymentWarning,
} from "@/core/domain";
import type {
  Clock,
  ContainerRuntime,
  DeployLease,
  DeployLock,
  DeploymentLogSink,
  DeploymentRepository,
  GitClient,
  HealthProbe,
  IdGenerator,
  ProbeOutcome,
  ProbeTarget,
  ProjectRepository,
  ReleaseRepository,
  ReverseProxy,
  SecretProvider,
  WorkerId,
} from "@/core/ports";

import {
  CAPTURED_LOG_LINES,
  NO_TIME_ELAPSED,
  PROBE_TIMEOUT,
  STOP_GRACE,
  deploymentContainerName,
  evaluateHealth,
  hasEnoughDisk,
  imagesToRemove,
} from "../policies";

export interface DeploymentEnginePorts {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly projects: ProjectRepository;
  readonly deployments: DeploymentRepository;
  readonly releases: ReleaseRepository;
  readonly lock: DeployLock;
  readonly git: GitClient;
  readonly containers: ContainerRuntime;
  readonly proxy: ReverseProxy;
  readonly health: HealthProbe;
  readonly logs: DeploymentLogSink;
  readonly secrets: SecretProvider;
}

/** Everything the locked phases need that is not on the deployment itself. */
interface RunContext {
  readonly project: Project;
  readonly lease: DeployLease;
  readonly environment: ReadonlyMap<string, string>;
}

export class DeploymentEngine {
  constructor(
    private readonly ports: DeploymentEnginePorts,
    /** Identifies this worker in the lock lease. */
    private readonly worker: WorkerId,
  ) {}

  /**
   * Run one deployment to a terminal state.
   *
   * Returns the terminal deployment on every path that reached one, including failures and
   * rollbacks — a failed deployment is a successful run of the engine. The `Result` fails
   * only when the platform could not record what happened, which is the one outcome a
   * caller can do nothing useful about.
   */
  async run(queued: Deployment): Promise<Result<Deployment>> {
    // Enter `validating` first: `queued` may only move to `validating` or `canceled`, so
    // nothing can be reported as failed until the deployment has left the queue.
    const validating = await this.apply(queued, (d) => d.startValidation(this.now()));
    if (!validating.ok) {
      return validating;
    }

    const project = await this.loadProject(queued.projectId);
    if (!project.ok) {
      return this.abandon(validating.value, project.error, "preflight");
    }

    // -- Phase 1: preflight. No lock, no server mutation, so a failure costs nothing.
    const preflight = await this.runPreflight(project.value, validating.value);
    if (!preflight.ok) {
      return this.abandon(validating.value, preflight.error, "preflight");
    }

    // -- Phase 2: take the lease. Everything past here mutates the host.
    const lease = await this.ports.lock.acquire({
      projectId: project.value.id,
      deploymentId: queued.id,
      holder: this.worker,
    });
    if (!lease.ok) {
      return this.abandon(validating.value, lease.error, "acquire_lock");
    }

    const preparing = await this.apply(validating.value, (d) =>
      d.beginPreparation(this.now(), lease.value.epoch),
    );
    if (!preparing.ok) {
      return preparing;
    }

    const context: RunContext = {
      project: project.value,
      lease: lease.value,
      environment: preflight.value,
    };

    let outcome: Result<Deployment>;
    try {
      outcome = await this.runLocked(preparing.value, context);
    } catch (thrown) {
      // A bug, not a deployment failure. Recorded as one anyway, so the lease is still
      // released and the deployment does not sit in an active state forever.
      outcome = await this.abandon(
        preparing.value,
        DeploymentError.of(
          "INVARIANT_VIOLATION",
          `The engine threw instead of returning a failure: ${describe(thrown)}`,
        ),
        "release_lock",
      );
    }

    // Invariant 7: every terminal state releases the lease except `rollback_failed`, which
    // retains it so no further automation stacks onto an unknown server state.
    if (!outcome.ok || !outcome.value.retainsLock) {
      const released = await this.ports.lock.release(context.lease);
      if (!released.ok && outcome.ok) {
        outcome = ok(await this.warnQuietly(outcome.value, released.error, "release_lock"));
      }
    }

    await this.ports.logs.complete(queued.id);
    return outcome;
  }

  // -- The locked flow ------------------------------------------------------

  /**
   * Steps 3 to 11, in order, holding the lease.
   *
   * Deliberately one long method. A method per step would have to thread the latest
   * deployment, the candidate, and the baseline through every signature and back out again
   * on failure, and the reader would lose the thing that matters most here: the order.
   */
  private async runLocked(preparing: Deployment, context: RunContext): Promise<Result<Deployment>> {
    const { project } = context;
    const config = project.config;
    let current = preparing;

    // -- Step 3: capture the baseline — the rollback contract, recorded before any change.
    await this.system(current, "capture_baseline", "capturing the current live release");
    const baseline = await this.captureBaseline(project);
    if (!baseline.ok) {
      return this.abandon(current, baseline.error, "capture_baseline");
    }
    const fetching = await this.apply(current, (d) =>
      d.captureBaseline(this.now(), baseline.value),
    );
    if (!fetching.ok) {
      return fetching;
    }
    current = fetching.value;

    // -- Step 4: update the source and pin the commit.
    await this.system(current, "update_source", `checking out ${current.targetRef}`);
    const resolved = await this.ports.git.checkOut(project, current.targetRef);
    if (!resolved.ok) {
      return this.abandon(current, resolved.error, "update_source");
    }
    const pinned = await this.apply(current, (d) =>
      d.recordResolvedSource(this.now(), resolved.value),
    );
    if (!pinned.ok) {
      return pinned;
    }
    current = pinned.value;

    // Nothing to do when the resolved commit is already the one serving traffic.
    if (Baselines.liveCommitSha(baseline.value) === resolved.value) {
      await this.system(current, "update_source", "resolved commit is already live");
      return this.apply(current, (d) => d.completeWithoutChange(this.now()));
    }

    // -- Step 5: build.
    const building = await this.apply(current, (d) => d.beginBuild(this.now()));
    if (!building.ok) {
      return building;
    }
    current = building.value;
    await this.system(current, "build", `building ${resolved.value}`);

    const built = await this.ports.containers.buildImage({
      project,
      commitSha: resolved.value,
      deploymentId: current.id,
      actor: current.actor,
    });
    if (!built.ok) {
      return this.abandon(current, built.error, "build");
    }
    const imaged = await this.apply(current, (d) =>
      d.recordImageBuilt(this.now(), built.value.reference, built.value.digest),
    );
    if (!imaged.ok) {
      return imaged;
    }
    current = imaged.value;

    // -- Step 6: start the candidate. No traffic on it yet.
    const starting = await this.apply(current, (d) => d.beginCandidateStart(this.now()));
    if (!starting.ok) {
      return starting;
    }
    current = starting.value;

    const containerName = deploymentContainerName(project.slug, current.id);
    if (!containerName.ok) {
      return this.abandon(current, containerName.error, "start_candidate");
    }
    await this.system(current, "start_candidate", `starting ${containerName.value}`);

    const started = await this.ports.containers.startContainer({
      project,
      name: containerName.value,
      image: built.value.reference,
      imageDigest: built.value.digest,
      commitSha: resolved.value,
      deploymentId: current.id,
      environment: context.environment,
    });
    if (!started.ok) {
      return this.abandon(current, started.error, "start_candidate");
    }

    const candidate = started.value;
    const upstream = candidate.upstream;
    if (upstream === undefined || candidate.state.kind === "exited") {
      return this.discard(
        current,
        candidate.id,
        DeploymentError.of(
          "CONTAINER_START_FAILED",
          upstream === undefined
            ? "the candidate started without a reachable address"
            : "the candidate exited immediately after starting",
        ),
      );
    }

    const candidateRecord = CandidateContainer.create({
      id: candidate.id,
      name: candidate.name,
      upstream: { host: upstream.host, port: upstream.port },
    });
    if (!candidateRecord.ok) {
      return this.discard(current, candidate.id, candidateRecord.error);
    }
    const withCandidate = await this.apply(current, (d) =>
      d.recordCandidateStarted(this.now(), candidateRecord.value),
    );
    if (!withCandidate.ok) {
      return withCandidate;
    }
    current = withCandidate.value;

    // -- Step 7: health check the candidate directly, before it can affect anyone.
    const checking = await this.apply(current, (d) => d.beginHealthCheck(this.now()));
    if (!checking.ok) {
      return checking;
    }
    current = checking.value;
    await this.system(current, "health_check", `probing ${config.healthCheck.path}`);

    const healthy = await this.waitForHealth({
      target: { kind: "upstream", upstream },
      spec: config.healthCheck,
      failureCode: "HEALTH_CHECK_FAILED",
      watch: candidate.id,
    });
    if (!healthy.ok) {
      // A discard, not a rollback: the previous release served every request throughout.
      await this.captureContainerLogs(current, candidate.id);
      return this.discard(current, candidate.id, healthy.error);
    }
    const passed = await this.apply(current, (d) => d.recordHealthCheckPassed(this.now()));
    if (!passed.ok) {
      return passed;
    }
    current = passed.value;

    // -- Step 8: promote. The only step that changes what users see.
    const promoting = await this.apply(current, (d) => d.beginPromotion(this.now()));
    if (!promoting.ok) {
      return promoting;
    }
    current = promoting.value;
    await this.system(current, "promote", `pointing ${config.route.toString()} at the candidate`);

    const switched = await this.ports.proxy.pointRouteAt(config.route, upstream);
    if (!switched.ok) {
      return this.rollback(current, switched.error, context, baseline.value, candidate.id);
    }

    // -- Step 9: verify through the public route. Proves the routing, not just the app.
    await this.system(current, "verify_route", "verifying the public route");
    const verified = await this.waitForHealth({
      target: { kind: "route", route: config.route },
      spec: config.healthCheck,
      failureCode: "ROUTE_VERIFICATION_FAILED",
      watch: undefined,
    });
    if (!verified.ok) {
      return this.rollback(current, verified.error, context, baseline.value, candidate.id);
    }
    const routeVerified = await this.apply(current, (d) => d.recordRouteVerified(this.now()));
    if (!routeVerified.ok) {
      return routeVerified;
    }
    current = routeVerified.value;

    // -- Steps 10 and 11: finalize, then succeed. Past here nothing can un-succeed the
    // deployment, so problems are recorded as warnings.
    const finalizing = await this.apply(current, (d) => d.beginFinalization(this.now()));
    if (!finalizing.ok) {
      return finalizing;
    }
    current = await this.finalize(finalizing.value, context, baseline.value);

    const succeeded = await this.apply(current, (d) => d.succeed(this.now()));
    if (!succeeded.ok) {
      return succeeded;
    }
    return ok(await this.recordRelease(succeeded.value, context));
  }

  // -- Phases ---------------------------------------------------------------

  /**
   * Preflight: everything checkable before the lock, returning the resolved runtime
   * environment so the start step need not resolve it again.
   *
   * Resolving both secrets here has a second purpose. The redactor the log sink is opened
   * with must know every secret value that could appear in output, and it can only know
   * them by reading them: the adapters resolve what they need in order to *use* it, the
   * engine resolves them in order to *hide* them.
   */
  private async runPreflight(
    project: Project,
    deployment: Deployment,
  ): Promise<Result<ReadonlyMap<string, string>>> {
    const config = project.config;

    const deployable = project.ensureDeployable();
    if (!deployable.ok) {
      return deployable;
    }

    for (const ref of [config.gitCredentialRef, config.runtimeEnvRef]) {
      const present = await this.ports.secrets.exists(ref);
      if (!present.ok) {
        return present;
      }
      if (!present.value) {
        return err(
          DeploymentError.of(
            "PREFLIGHT_CREDENTIAL_MISSING",
            `Secret "${ref}" is not available, so the deployment would fail mid-flight`,
            { details: { ref } },
          ),
        );
      }
    }

    const credential = await this.ports.secrets.resolveCredential(config.gitCredentialRef);
    if (!credential.ok) {
      return credential;
    }
    const environment = await this.ports.secrets.resolveEnvironment(config.runtimeEnvRef);
    if (!environment.ok) {
      return environment;
    }

    const opened = await this.ports.logs.open(
      deployment.id,
      Redactor.create([credential.value, ...environment.value.values()]),
    );
    if (!opened.ok) {
      return opened;
    }
    await this.system(deployment, "preflight", "credentials resolved");

    // Doubles as the runtime reachability check: this is a call to the host.
    const headroom = await this.ports.containers.readStorageHeadroom();
    if (!headroom.ok) {
      return headroom;
    }
    if (!hasEnoughDisk(headroom.value.freeBytes)) {
      return err(
        DeploymentError.of(
          "PREFLIGHT_DISK_SPACE_LOW",
          `Only ${headroom.value.freeBytes} bytes free on the host; a build could fill the disk and take the live release down with it`,
          { details: { freeBytes: headroom.value.freeBytes } },
        ),
      );
    }

    await this.system(deployment, "preflight", "preflight passed");
    return ok(environment.value);
  }

  /**
   * What is live right now, read from the host rather than from the record.
   *
   * The proxy is authoritative about which container serves traffic, so the baseline is
   * whichever container the route currently points at. If the route points somewhere no
   * container answers for, the deployment stops: proceeding would mean building with no
   * known-good state to return to.
   */
  private async captureBaseline(project: Project): Promise<Result<Baseline>> {
    const upstream = await this.ports.proxy.readUpstream(project.config.route);
    if (!upstream.ok) {
      return upstream;
    }
    const current = upstream.value;
    if (current === undefined) {
      return ok(Baselines.firstDeploy());
    }

    const containers = await this.ports.containers.findForProject(project);
    if (!containers.ok) {
      return containers;
    }

    const live = containers.value.find(
      (snapshot) =>
        snapshot.upstream !== undefined &&
        snapshot.upstream.host === current.host &&
        snapshot.upstream.port === current.port,
    );
    if (live === undefined) {
      return err(
        DeploymentError.of(
          "BASELINE_REQUIRED",
          `The route points at ${current.host}:${current.port} but no container answers for it, so there is no rollback target`,
          { details: { host: current.host, port: current.port } },
        ),
      );
    }

    return Baselines.existing({
      containerId: live.id,
      containerName: live.name,
      image: live.image,
      imageDigest: live.imageDigest,
      commitSha: live.commitSha,
      upstream: { host: live.upstream?.host, port: live.upstream?.port },
    });
  }

  /**
   * Probe until the policy says pass or fail.
   *
   * The loop is here because waiting is a side effect; the decision is a pure function.
   * `watch` is the candidate's id when probing it directly, so a container that exits
   * mid-run fails immediately rather than waiting out the budget on something already gone.
   */
  private async waitForHealth(request: {
    readonly target: ProbeTarget;
    readonly spec: HealthCheckSpec;
    readonly failureCode: ErrorCode;
    readonly watch: ContainerId | undefined;
  }): Promise<Result<void>> {
    const startedAt = this.now();
    const attempts: ProbeOutcome[] = [];

    for (;;) {
      if (request.watch !== undefined) {
        const stillRunning = await this.assertStillRunning(request.watch);
        if (!stillRunning.ok) {
          return stillRunning;
        }
      }

      const outcome = await this.ports.health.probe({
        target: request.target,
        path: request.spec.path,
        timeout: PROBE_TIMEOUT,
      });
      if (!outcome.ok) {
        return outcome;
      }
      attempts.push(outcome.value);

      const decision = evaluateHealth({
        spec: request.spec,
        attempts,
        elapsed: this.elapsedSince(startedAt),
      });
      if (decision.kind === "pass") {
        return ok(undefined);
      }
      if (decision.kind === "fail") {
        return err(DeploymentError.of(request.failureCode, decision.reason));
      }
      await this.ports.clock.sleep(decision.waitFor);
    }
  }

  private async assertStillRunning(id: ContainerId): Promise<Result<void>> {
    const snapshot = await this.ports.containers.inspect(id);
    if (!snapshot.ok) {
      return snapshot;
    }
    const state = snapshot.value?.state;
    if (state === undefined) {
      return err(
        DeploymentError.of("CONTAINER_EXITED", "the candidate disappeared while being probed"),
      );
    }
    if (state.kind === "exited") {
      return err(
        DeploymentError.of(
          "CONTAINER_EXITED",
          `the candidate exited with code ${state.exitCode} while being probed`,
        ),
      );
    }
    if (state.kind === "stopped") {
      return err(
        DeploymentError.of("CONTAINER_EXITED", "the candidate stopped while being probed"),
      );
    }
    return ok(undefined);
  }

  /**
   * Finalization: stop the previous container and prune old images.
   *
   * Every failure here is a warning. The release is live and verified; refusing to call
   * that a success because a prune failed would be wrong.
   */
  private async finalize(
    deployment: Deployment,
    context: RunContext,
    baseline: Baseline,
  ): Promise<Deployment> {
    let current = deployment;

    if (baseline.kind === "existing") {
      await this.system(current, "finalize", "stopping the previous container");
      const stopped = await this.ports.containers.stop(baseline.containerId, STOP_GRACE);
      if (!stopped.ok) {
        current = await this.warnQuietly(current, stopped.error, "finalize");
      }
    }

    const prunable = await this.prunableImages(context, baseline);
    if (prunable.length > 0) {
      await this.system(current, "finalize", `pruning ${prunable.length} image(s)`);
      const removed = await this.ports.containers.removeImages(prunable);
      if (!removed.ok) {
        current = await this.warnQuietly(current, removed.error, "finalize");
      }
    }

    return current;
  }

  /**
   * Record the release, after succeeding.
   *
   * The order is forced by the domain and is the right one: only a succeeded deployment
   * can produce a `Release`, which is what guarantees every rollback target was once live
   * and verified. A failure to persist it is a warning, not a retraction of a deployment
   * that is already serving traffic.
   */
  private async recordRelease(succeeded: Deployment, context: RunContext): Promise<Deployment> {
    const release = succeeded.toRelease(this.ports.ids.nextReleaseId());
    if (!release.ok) {
      return this.warnQuietly(succeeded, release.error, "finalize");
    }
    const saved = await this.ports.releases.save(release.value);
    if (!saved.ok) {
      return this.warnQuietly(succeeded, saved.error, "finalize");
    }
    await this.system(
      succeeded,
      "finalize",
      `released ${release.value.id} at ${context.project.config.route.toString()}`,
    );
    return succeeded;
  }

  private async prunableImages(
    context: RunContext,
    baseline: Baseline,
  ): Promise<readonly ImageDigest[]> {
    const releases = await this.ports.releases.listForProject(
      context.project.id,
      context.project.config.imageRetention + 10,
    );
    if (!releases.ok) {
      return [];
    }
    return imagesToRemove({
      retention: context.project.config.imageRetention,
      releases: releases.value,
      protectedDigests: baseline.kind === "existing" ? [baseline.imageDigest] : [],
    });
  }

  // -- Failure paths --------------------------------------------------------

  /** Fail before promotion, having started nothing on the host that needs undoing. */
  private async abandon(
    deployment: Deployment,
    error: DeploymentError,
    step: StepName,
  ): Promise<Result<Deployment>> {
    await this.system(deployment, step, `failed: ${error.message}`);
    return this.apply(deployment, (d) => d.fail(this.now(), error));
  }

  /**
   * Compensation one of two: remove the candidate.
   *
   * Applies to every failure before promotion. Nothing was switched, so the previous
   * release is still serving and there is nothing to restore.
   */
  private async discard(
    deployment: Deployment,
    candidateId: ContainerId,
    error: DeploymentError,
  ): Promise<Result<Deployment>> {
    await this.system(deployment, "start_candidate", `discarding the candidate: ${error.message}`);
    let current = deployment;
    const removed = await this.ports.containers.remove(candidateId);
    if (!removed.ok) {
      current = await this.warnQuietly(current, removed.error, "start_candidate");
    }
    return this.apply(current, (d) => d.fail(this.now(), error));
  }

  /**
   * Compensation two of two: put the previous release back.
   *
   * The previous container is deliberately still running at this point, so this is one
   * proxy change rather than a cold start under pressure. If it fails, the deployment ends
   * in `rollback_failed`, which retains the lease and requires a human.
   */
  private async rollback(
    deployment: Deployment,
    cause: DeploymentError,
    context: RunContext,
    baseline: Baseline,
    candidateId: ContainerId,
  ): Promise<Result<Deployment>> {
    const rollingBack = await this.apply(deployment, (d) => d.beginRollback(this.now(), cause));
    if (!rollingBack.ok) {
      return rollingBack;
    }
    const current = rollingBack.value;
    await this.system(current, "promote", `rolling back: ${cause.message}`);

    if (baseline.kind === "first_deploy") {
      // Nothing to return to. Remove the candidate and leave the route unconfigured rather
      // than pointing it at something that failed verification.
      await this.ports.containers.remove(candidateId);
      return this.apply(current, (d) => d.completeRollback(this.now()));
    }

    const restored = await this.restoreBaseline(context, baseline);
    if (!restored.ok) {
      return this.apply(current, (d) =>
        d.failRollback(
          this.now(),
          DeploymentError.of(
            "ROLLBACK_FAILED",
            `Could not point the route back at the previous release: ${restored.error.message}`,
            { details: { cause: cause.code } },
          ),
        ),
      );
    }

    await this.ports.containers.remove(candidateId);
    return this.apply(current, (d) => d.completeRollback(this.now()));
  }

  private async restoreBaseline(
    context: RunContext,
    baseline: ExistingBaseline,
  ): Promise<Result<void>> {
    return this.ports.proxy.pointRouteAt(context.project.config.route, baseline.upstream);
  }

  private async captureContainerLogs(deployment: Deployment, id: ContainerId): Promise<void> {
    const lines = await this.ports.containers.readLogs(id, CAPTURED_LOG_LINES);
    if (!lines.ok) {
      return;
    }
    for (const text of lines.value) {
      await this.ports.logs.append(deployment.id, {
        at: this.now(),
        step: "health_check",
        stream: "stderr",
        text,
      });
    }
  }

  // -- Small helpers --------------------------------------------------------

  private now(): Timestamp {
    return this.ports.clock.now();
  }

  private elapsedSince(startedAt: Timestamp): Duration {
    const elapsed = this.now().since(startedAt);
    return elapsed.ok ? elapsed.value : NO_TIME_ELAPSED;
  }

  private async loadProject(id: ProjectId): Promise<Result<Project>> {
    const found = await this.ports.projects.findById(id);
    if (!found.ok) {
      return found;
    }
    if (found.value === undefined) {
      return err(
        DeploymentError.of("PROJECT_NOT_FOUND", `Project ${id} does not exist`, {
          details: { projectId: id },
        }),
      );
    }
    return ok(found.value);
  }

  /** Apply a domain change and persist it. The only way this engine changes state. */
  private async apply(
    deployment: Deployment,
    change: (deployment: Deployment) => Result<Deployment>,
  ): Promise<Result<Deployment>> {
    const changed = change(deployment);
    if (!changed.ok) {
      return changed;
    }
    const saved = await this.ports.deployments.save(changed.value);
    return saved.ok ? ok(changed.value) : saved;
  }

  /** Attach a warning. A failure to record it must not mask the outcome it annotates. */
  private async warnQuietly(
    deployment: Deployment,
    error: DeploymentError,
    step: StepName,
  ): Promise<Deployment> {
    const warned = await this.apply(deployment, (d) =>
      d.addWarning(DeploymentWarning.fromError(error, this.now(), step)),
    );
    return warned.ok ? warned.value : deployment;
  }

  /** Write one platform-authored log line. Never fails the deployment. */
  private async system(deployment: Deployment, step: StepName, text: string): Promise<void> {
    await this.ports.logs.append(deployment.id, {
      at: this.now(),
      step,
      stream: "system",
      text,
    });
  }
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
}
