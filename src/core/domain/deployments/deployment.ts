/**
 * The `Deployment` aggregate — the heart of the platform.
 *
 * A deployment owns its own lifecycle. There is no setter, no public constructor,
 * and no way to assign a state: every change goes through a named method that
 * asserts the transition against the state machine and the preconditions that state
 * requires. An illegal transition is not merely discouraged, it is unreachable
 * through this API, and that is the point — the alternative is a `state` field that
 * any caller can overwrite and a set of rules that live in whichever service
 * remembered to check them.
 *
 * Every method returns a **new** `Deployment`. The aggregate is immutable, so a
 * failed transition leaves the caller holding the unchanged original rather than a
 * half-mutated object, and a snapshot taken for logging can never change underneath
 * the log line.
 *
 * The invariants are the eight in `docs/architecture/deployment-engine.md` §
 * Invariants. Where one is enforced structurally — by a state being unreachable
 * rather than by a check — the comment says so. `deployment-consistency.ts` re-checks
 * all of them when a record is loaded from storage.
 */

import {
  type Actor,
  type CommitSha,
  type DeploymentId,
  type GitRef,
  type IdempotencyKey,
  type ImageDigest,
  type LockEpoch,
  type ProjectId,
  type ReleaseId,
  type Result,
  DeploymentError,
  Duration,
  ImageReference,
  Timestamp,
  err,
  ok,
} from "@/core/shared";

import { type Baseline, Baselines } from "./baseline";
import { CandidateContainer } from "./candidate";
import { consistencyIssues } from "./deployment-consistency";
import {
  type DeploymentState,
  assertTransition,
  isActive,
  isTerminal,
  requiresLock,
} from "./deployment-state";
import {
  type DeploymentOutcome,
  type DeploymentTrigger,
  parseDeploymentTrigger,
} from "./deployment-trigger";
import { Release } from "./release";
import { type RunningStep, type StepName, type StepRecord, StepRecords, isRunning } from "./step";
import { DeploymentWarning } from "./warning";

/** One entry in the audit trail. Append-only; never rewritten. */
export interface StateTransition {
  readonly from: DeploymentState;
  readonly to: DeploymentState;
  readonly at: Timestamp;
  readonly reason: string | undefined;
}

/**
 * The aggregate's complete state.
 *
 * Optional fields are declared as `T | undefined` rather than `?:` so the key is
 * always present: a snapshot round-trip cannot silently drop a field, and the
 * consistency checks can distinguish "absent" from "not part of this shape".
 */
export interface DeploymentFields {
  readonly id: DeploymentId;
  readonly projectId: ProjectId;
  readonly trigger: DeploymentTrigger;
  readonly actor: Actor;
  /** What was asked for. Resolved to `resolvedSha` during the fetch step. */
  readonly targetRef: GitRef;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestedAt: Timestamp;
  readonly state: DeploymentState;
  readonly lockEpoch: LockEpoch | undefined;
  readonly baseline: Baseline | undefined;
  /** The immutable commit this deployment is actually building. */
  readonly resolvedSha: CommitSha | undefined;
  readonly image: ImageReference | undefined;
  readonly imageDigest: ImageDigest | undefined;
  readonly candidate: CandidateContainer | undefined;
  readonly healthCheckPassedAt: Timestamp | undefined;
  readonly routeVerifiedAt: Timestamp | undefined;
  readonly interruptedFrom: DeploymentState | undefined;
  readonly outcome: DeploymentOutcome | undefined;
  readonly error: DeploymentError | undefined;
  readonly finishedAt: Timestamp | undefined;
  readonly warnings: readonly DeploymentWarning[];
  readonly steps: readonly StepRecord[];
  readonly transitions: readonly StateTransition[];
}

/** What persistence stores and reconstitutes. Identical to the internal shape. */
export type DeploymentSnapshot = DeploymentFields;

export interface DeploymentRequestInput {
  readonly id: DeploymentId;
  readonly projectId: ProjectId;
  readonly trigger: DeploymentTrigger;
  readonly actor: Actor;
  readonly targetRef: GitRef;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestedAt: Timestamp;
}

export class Deployment {
  private constructor(private readonly fields: DeploymentFields) {}

  // -- Construction ---------------------------------------------------------

  /**
   * Create a deployment in `queued`. Admission checks — project enabled, no other
   * active deployment, idempotency key not already used — belong to the use case,
   * because they need to see other records and an aggregate sees only itself.
   */
  static request(input: DeploymentRequestInput): Result<Deployment> {
    const trigger = parseDeploymentTrigger(input.trigger);
    if (!trigger.ok) {
      return trigger;
    }
    return ok(
      new Deployment(
        Object.freeze({
          id: input.id,
          projectId: input.projectId,
          trigger: trigger.value,
          actor: input.actor,
          targetRef: input.targetRef,
          idempotencyKey: input.idempotencyKey,
          requestedAt: input.requestedAt,
          state: "queued",
          lockEpoch: undefined,
          baseline: undefined,
          resolvedSha: undefined,
          image: undefined,
          imageDigest: undefined,
          candidate: undefined,
          healthCheckPassedAt: undefined,
          routeVerifiedAt: undefined,
          interruptedFrom: undefined,
          outcome: undefined,
          error: undefined,
          finishedAt: undefined,
          warnings: Object.freeze([]),
          steps: Object.freeze([]),
          transitions: Object.freeze([]),
        }),
      ),
    );
  }

  /** Reconstitute from storage, re-checking every rule in `deployment-consistency`. */
  static rehydrate(snapshot: DeploymentSnapshot): Result<Deployment> {
    const issues = consistencyIssues(snapshot);
    if (issues.length > 0) {
      return err(
        DeploymentError.validation("DEPLOYMENT_INVALID", "Inconsistent deployment record", issues, {
          deploymentId: snapshot.id,
          state: snapshot.state,
        }),
      );
    }
    return ok(
      new Deployment(
        Object.freeze({
          ...snapshot,
          warnings: Object.freeze([...snapshot.warnings]),
          steps: Object.freeze([...snapshot.steps]),
          transitions: Object.freeze([...snapshot.transitions]),
        }),
      ),
    );
  }

  // -- Identity and plain state --------------------------------------------

  get id(): DeploymentId {
    return this.fields.id;
  }

  get projectId(): ProjectId {
    return this.fields.projectId;
  }

  get trigger(): DeploymentTrigger {
    return this.fields.trigger;
  }

  get actor(): Actor {
    return this.fields.actor;
  }

  get targetRef(): GitRef {
    return this.fields.targetRef;
  }

  get idempotencyKey(): IdempotencyKey {
    return this.fields.idempotencyKey;
  }

  get requestedAt(): Timestamp {
    return this.fields.requestedAt;
  }

  get state(): DeploymentState {
    return this.fields.state;
  }

  get lockEpoch(): LockEpoch | undefined {
    return this.fields.lockEpoch;
  }

  get baseline(): Baseline | undefined {
    return this.fields.baseline;
  }

  get resolvedSha(): CommitSha | undefined {
    return this.fields.resolvedSha;
  }

  get image(): ImageReference | undefined {
    return this.fields.image;
  }

  get imageDigest(): ImageDigest | undefined {
    return this.fields.imageDigest;
  }

  get candidate(): CandidateContainer | undefined {
    return this.fields.candidate;
  }

  get healthCheckPassedAt(): Timestamp | undefined {
    return this.fields.healthCheckPassedAt;
  }

  get routeVerifiedAt(): Timestamp | undefined {
    return this.fields.routeVerifiedAt;
  }

  get interruptedFrom(): DeploymentState | undefined {
    return this.fields.interruptedFrom;
  }

  get outcome(): DeploymentOutcome | undefined {
    return this.fields.outcome;
  }

  get error(): DeploymentError | undefined {
    return this.fields.error;
  }

  get finishedAt(): Timestamp | undefined {
    return this.fields.finishedAt;
  }

  get warnings(): readonly DeploymentWarning[] {
    return this.fields.warnings;
  }

  get steps(): readonly StepRecord[] {
    return this.fields.steps;
  }

  get transitions(): readonly StateTransition[] {
    return this.fields.transitions;
  }

  // -- Derived state --------------------------------------------------------

  get isActive(): boolean {
    return isActive(this.fields.state);
  }

  get isTerminal(): boolean {
    return isTerminal(this.fields.state);
  }

  /** Invariant 2: whether the lock must be held for the current state. */
  get requiresLock(): boolean {
    return requiresLock(this.fields.state);
  }

  /** True only in `rollback_failed`, where the lock is deliberately retained. */
  get retainsLock(): boolean {
    return this.fields.state === "rollback_failed";
  }

  get isFirstDeploy(): boolean {
    return this.fields.baseline !== undefined && Baselines.isFirstDeploy(this.fields.baseline);
  }

  /** Whether this deployment ever reached a given state. Drives recovery rules. */
  hasReached(state: DeploymentState): boolean {
    return state === "queued" || this.fields.transitions.some((t) => t.to === state);
  }

  /** The step currently in flight, if any. */
  get currentStep(): StepName | undefined {
    return this.fields.steps.find(isRunning)?.name;
  }

  /** Total wall-clock time, once finished. */
  get totalDuration(): Duration | undefined {
    const finishedAt = this.fields.finishedAt;
    if (finishedAt === undefined) {
      return undefined;
    }
    const elapsed = finishedAt.since(this.fields.requestedAt);
    return elapsed.ok ? elapsed.value : undefined;
  }

  // -- Lifecycle: preflight and lock ---------------------------------------

  /** `queued` → `validating`. Preflight runs before any lock is taken. */
  startValidation(at: Timestamp): Result<Deployment> {
    return this.transition("validating", at);
  }

  /**
   * `validating` → `preparing`. The lock has been acquired; the fencing epoch is
   * recorded so every later mutation can be checked against it.
   */
  beginPreparation(at: Timestamp, lockEpoch: LockEpoch): Result<Deployment> {
    return this.transition("preparing", at, { lockEpoch });
  }

  /**
   * `preparing` → `fetching`, recording the rollback target.
   *
   * Invariant 3 is structural: this is the only transition into `fetching`, and
   * `building` is only reachable from `fetching`, so no build can happen without a
   * baseline having been captured first.
   */
  captureBaseline(at: Timestamp, baseline: Baseline): Result<Deployment> {
    return this.transition("fetching", at, { baseline });
  }

  // -- Lifecycle: source and build -----------------------------------------

  /** Record the sha the target ref resolved to. Everything downstream uses it. */
  recordResolvedSource(at: Timestamp, resolvedSha: CommitSha): Result<Deployment> {
    return this.mutate("recordResolvedSource", at, ["fetching"], { resolvedSha });
  }

  /**
   * `fetching` → `succeeded` with `outcome: no_change` — the short circuit.
   *
   * Only legal when the resolved sha is exactly what is already live. Without that
   * check this method would be a way to mark any deployment successful without
   * deploying it.
   */
  completeWithoutChange(at: Timestamp): Result<Deployment> {
    const legal = this.ensureCanTransition("succeeded");
    if (!legal.ok) {
      return legal;
    }
    const resolvedSha = this.fields.resolvedSha;
    if (resolvedSha === undefined) {
      return err(
        DeploymentError.of(
          "SOURCE_NOT_RESOLVED",
          "Cannot complete without change before the target ref has been resolved",
        ),
      );
    }
    const baseline = this.fields.baseline;
    const liveSha = baseline === undefined ? undefined : Baselines.liveCommitSha(baseline);
    if (liveSha === undefined) {
      return err(
        DeploymentError.of(
          "BASELINE_REQUIRED",
          "Cannot complete without change: there is no live release to compare against",
        ),
      );
    }
    if (liveSha !== resolvedSha) {
      return err(
        DeploymentError.of(
          "INVARIANT_VIOLATION",
          `Cannot complete without change: resolved sha ${resolvedSha} differs from the live sha ${liveSha}`,
          { details: { resolvedSha, liveSha } },
        ),
      );
    }
    return this.transition("succeeded", at, { outcome: "no_change" }, "resolved sha already live");
  }

  /**
   * Reject a move the lifecycle does not allow, before any precondition is examined.
   *
   * Ordering matters for diagnosis: calling `beginBuild` while still `preparing` fails
   * both the transition rule and the "source resolved" precondition, and "cannot
   * transition preparing -> building" is the useful message. The precondition would
   * merely describe a symptom.
   */
  private ensureCanTransition(to: DeploymentState): Result<void> {
    return assertTransition(this.fields.state, to);
  }

  /** `fetching` → `building`. Requires a resolved sha and a captured baseline. */
  beginBuild(at: Timestamp): Result<Deployment> {
    const legal = this.ensureCanTransition("building");
    if (!legal.ok) {
      return legal;
    }
    if (this.fields.resolvedSha === undefined) {
      return err(
        DeploymentError.of(
          "SOURCE_NOT_RESOLVED",
          "Cannot build before the target ref has been resolved to a commit sha",
        ),
      );
    }
    if (this.fields.baseline === undefined) {
      return err(
        DeploymentError.of("BASELINE_REQUIRED", "Cannot build before a baseline has been captured"),
      );
    }
    return this.transition("building", at);
  }

  /** Record the built image and its digest. */
  recordImageBuilt(
    at: Timestamp,
    image: ImageReference,
    imageDigest: ImageDigest,
  ): Result<Deployment> {
    return this.mutate("recordImageBuilt", at, ["building"], { image, imageDigest });
  }

  // -- Lifecycle: candidate and health -------------------------------------

  /** `building` → `starting`. Requires a built image. */
  beginCandidateStart(at: Timestamp): Result<Deployment> {
    const legal = this.ensureCanTransition("starting");
    if (!legal.ok) {
      return legal;
    }
    if (this.fields.image === undefined || this.fields.imageDigest === undefined) {
      return err(
        DeploymentError.of("IMAGE_NOT_BUILT", "Cannot start a candidate before an image is built"),
      );
    }
    return this.transition("starting", at);
  }

  /** Record the candidate container, running on an internal port with no traffic. */
  recordCandidateStarted(at: Timestamp, candidate: CandidateContainer): Result<Deployment> {
    return this.mutate("recordCandidateStarted", at, ["starting"], { candidate });
  }

  /** `starting` → `health_checking`. Requires a running candidate. */
  beginHealthCheck(at: Timestamp): Result<Deployment> {
    const legal = this.ensureCanTransition("health_checking");
    if (!legal.ok) {
      return legal;
    }
    if (this.fields.candidate === undefined) {
      return err(
        DeploymentError.of(
          "CANDIDATE_NOT_STARTED",
          "Cannot health check before the candidate container has started",
        ),
      );
    }
    return this.transition("health_checking", at);
  }

  /**
   * Record that the candidate passed its health check.
   *
   * Separate from `beginPromotion` on purpose: the pass is a fact that must be
   * recorded before promotion becomes reachable, which is how invariant 4 — no
   * promotion without a passed health check — is enforced by construction rather
   * than by remembering to check.
   */
  recordHealthCheckPassed(at: Timestamp): Result<Deployment> {
    return this.mutate("recordHealthCheckPassed", at, ["health_checking"], {
      healthCheckPassedAt: at,
    });
  }

  // -- Lifecycle: promotion -------------------------------------------------

  /** `health_checking` → `promoting`. Invariant 4. */
  beginPromotion(at: Timestamp): Result<Deployment> {
    const legal = this.ensureCanTransition("promoting");
    if (!legal.ok) {
      return legal;
    }
    if (this.fields.healthCheckPassedAt === undefined) {
      return err(
        DeploymentError.of(
          "HEALTH_CHECK_NOT_PASSED",
          "Cannot promote a candidate that has not passed its health check",
        ),
      );
    }
    return this.transition("promoting", at);
  }

  /**
   * Record that the application answered through its **public route**.
   *
   * A distinct fact from the pre-promotion health check: that one proved the
   * application works, this proves the routing does. A correct container behind a
   * proxy pointing at a stale port is a complete outage that the first check reports
   * as a success. No deployment may report a `deployed` success without this — by
   * either the normal path or reconciliation.
   */
  recordRouteVerified(at: Timestamp): Result<Deployment> {
    return this.mutate("recordRouteVerified", at, ["promoting"], { routeVerifiedAt: at });
  }

  /** `promoting` → `finalizing`. Requires route verification. */
  beginFinalization(at: Timestamp): Result<Deployment> {
    const legal = this.ensureCanTransition("finalizing");
    if (!legal.ok) {
      return legal;
    }
    if (this.fields.routeVerifiedAt === undefined) {
      return err(
        DeploymentError.of(
          "ROUTE_NOT_VERIFIED",
          "Cannot finalize before the public route has been verified",
        ),
      );
    }
    return this.transition("finalizing", at);
  }

  /** `finalizing` → `succeeded`. The release is live and verified. */
  succeed(at: Timestamp): Result<Deployment> {
    return this.transition("succeeded", at, { outcome: "deployed" });
  }

  // -- Lifecycle: failure, rollback, cancellation ---------------------------

  /**
   * Fail before promotion. The candidate is discarded; the previous release served
   * traffic throughout.
   *
   * There is no path from `promoting` or `finalizing` — after traffic has been
   * switched the response is a rollback, and after verification the release has
   * shipped. The state machine enforces that; this method cannot be misused to
   * bypass it.
   */
  fail(at: Timestamp, error: DeploymentError): Result<Deployment> {
    return this.transition("failed", at, { error }, error.code);
  }

  /** Stop at a step boundary on request. Never mid-promotion. */
  cancel(at: Timestamp, reason?: string): Result<Deployment> {
    return this.transition("canceled", at, {}, reason ?? "canceled by operator");
  }

  /**
   * `starting` | `health_checking` | `promoting` → `rolling_back`. The one place
   * automatic rollback begins.
   *
   * Reachable from three states rather than one because the classic strategy displaces
   * the previous container before the new one starts (D12): from `starting` onward there
   * is an outage to compensate for, not merely a candidate to discard.
   *
   * `error` is the failure that triggered it — kept so the timeline explains *why*
   * the platform rolled back, not merely that it did.
   */
  beginRollback(at: Timestamp, error: DeploymentError): Result<Deployment> {
    return this.transition("rolling_back", at, { error }, error.code);
  }

  /** `rolling_back` → `rolled_back`. The previous release is live again. */
  completeRollback(at: Timestamp): Result<Deployment> {
    return this.transition("rolled_back", at);
  }

  /**
   * `rolling_back` → `rollback_failed`. Automatic recovery did not work.
   *
   * The lock is deliberately **not** released, so no further automation stacks onto
   * an unknown server state. This is the only outcome that requires a human.
   */
  failRollback(at: Timestamp, error: DeploymentError): Result<Deployment> {
    return this.transition("rollback_failed", at, { error }, error.code);
  }

  // -- Lifecycle: interruption and recovery --------------------------------

  /**
   * The worker died. Records which state it died in, because the reconciler's
   * decision depends entirely on that.
   */
  markInterrupted(at: Timestamp, reason?: string): Result<Deployment> {
    const from = this.fields.state;
    if (!isActive(from) || from === "interrupted") {
      return err(
        DeploymentError.of(
          "OPERATION_NOT_VALID_IN_STATE",
          `Cannot mark a deployment in state "${from}" as interrupted`,
          { details: { state: from } },
        ),
      );
    }
    return this.transition(
      "interrupted",
      at,
      { interruptedFrom: from },
      reason ?? "worker did not complete",
    );
  }

  /** Reconciled: the candidate never took traffic, so nothing shipped. */
  resolveInterruptedAsFailed(at: Timestamp, error: DeploymentError): Result<Deployment> {
    const guard = this.requireInterrupted();
    return guard.ok ? this.transition("failed", at, { error }, "reconciled") : guard;
  }

  /**
   * Reconciled: the promotion had in fact completed, so finalization was re-run and
   * the deployment is a success.
   *
   * Requires that the public route was verified. The reconciler reaches `succeeded`
   * without passing through `finalizing`, so without this check recovery would be a
   * back door around the rule the normal path enforces — and the `Release` it then
   * produced would become a rollback target that was never confirmed to serve
   * traffic. Reconciliation must record the verification it performed
   * (`recordRouteVerified` before interruption, or none at all) rather than assert
   * success on the strength of having reached promotion.
   */
  resolveInterruptedAsSucceeded(at: Timestamp): Result<Deployment> {
    const guard = this.requireInterrupted();
    if (!guard.ok) {
      return guard;
    }
    if (this.fields.routeVerifiedAt === undefined) {
      return err(
        DeploymentError.of(
          "ROUTE_NOT_VERIFIED",
          `Cannot resolve an interrupted deployment as succeeded: the public route was never verified (interrupted from "${String(this.fields.interruptedFrom)}")`,
          { details: { interruptedFrom: this.fields.interruptedFrom } },
        ),
      );
    }
    return this.transition("succeeded", at, { outcome: "deployed" }, "reconciled");
  }

  /** Reconciled: the server's state could not be determined. A human is required. */
  resolveInterruptedAsRollbackFailed(at: Timestamp, error: DeploymentError): Result<Deployment> {
    const guard = this.requireInterrupted();
    return guard.ok ? this.transition("rollback_failed", at, { error }, "reconciled") : guard;
  }

  // -- Annotations ----------------------------------------------------------

  /**
   * Attach a warning. Never changes the outcome.
   *
   * Permitted in any state, including terminal ones: compensations and finalization
   * steps run around the transition that ends a deployment, and losing the record of
   * a failed prune because the state had already moved on would defeat the purpose.
   */
  addWarning(warning: DeploymentWarning): Result<Deployment> {
    if (warning.at.isBefore(this.fields.requestedAt)) {
      return err(
        DeploymentError.of(
          "NON_MONOTONIC_TIMESTAMP",
          "A warning cannot predate the deployment request",
        ),
      );
    }
    return ok(this.next({ warnings: Object.freeze([...this.fields.warnings, warning]) }));
  }

  // -- Step records ---------------------------------------------------------

  /** Begin a step. One step runs at a time, and each step is recorded once. */
  startStep(name: StepName, at: Timestamp): Result<Deployment> {
    const running = this.fields.steps.find(isRunning);
    if (running !== undefined) {
      return err(
        DeploymentError.of(
          "OPERATION_NOT_VALID_IN_STATE",
          `Cannot start step "${name}" while "${running.name}" is still running`,
          { details: { running: running.name } },
        ),
      );
    }
    const duplicate = this.rejectDuplicateStep(name);
    if (!duplicate.ok) {
      return duplicate;
    }
    const timing = this.checkMonotonic(at);
    if (!timing.ok) {
      return timing;
    }
    return ok(
      this.next({ steps: Object.freeze([...this.fields.steps, StepRecords.start(name, at)]) }),
    );
  }

  /** Another attempt at the running step. Attempts accumulate on one record. */
  retryStep(): Result<Deployment> {
    return this.withRunningStep("retryStep", (running) => ok(StepRecords.retry(running)));
  }

  completeStep(at: Timestamp): Result<Deployment> {
    return this.withRunningStep("completeStep", (running) => StepRecords.succeed(running, at));
  }

  failStep(at: Timestamp, error: DeploymentError): Result<Deployment> {
    return this.withRunningStep("failStep", (running) => StepRecords.fail(running, at, error));
  }

  /** Record a step the pipeline deliberately did not run. */
  skipStep(name: StepName, at: Timestamp, reason: string): Result<Deployment> {
    const duplicate = this.rejectDuplicateStep(name);
    if (!duplicate.ok) {
      return duplicate;
    }
    return ok(
      this.next({
        steps: Object.freeze([...this.fields.steps, StepRecords.skip(name, at, reason)]),
      }),
    );
  }

  // -- Producing a release --------------------------------------------------

  /**
   * Produce the `Release` record for a deployment that shipped.
   *
   * The only way a `Release` can be created. A failed, rolled-back, or no-change
   * deployment cannot produce one, which is what guarantees that every rollback
   * target was once live and verified through its public route: reaching
   * `succeeded` with `outcome: deployed` requires `routeVerifiedAt`, enforced both by
   * the transitions into that state and by `deployment-consistency` on load. No
   * redundant check is made here — it would be unreachable.
   *
   * Takes no timestamp: a succeeded deployment already knows when it finished, and
   * accepting a "now" would invite a release dated at something other than the moment
   * it actually went live.
   */
  toRelease(releaseId: ReleaseId): Result<Release> {
    if (this.fields.state !== "succeeded") {
      return err(
        DeploymentError.of(
          "OPERATION_NOT_VALID_IN_STATE",
          `Only a succeeded deployment produces a release (state is "${this.fields.state}")`,
          { details: { state: this.fields.state } },
        ),
      );
    }
    if (this.fields.outcome !== "deployed") {
      return err(
        DeploymentError.of(
          "OPERATION_NOT_VALID_IN_STATE",
          "A no-change deployment shipped nothing and produces no release",
        ),
      );
    }
    const { resolvedSha, image, imageDigest, candidate, finishedAt } = this.fields;
    if (
      resolvedSha === undefined ||
      image === undefined ||
      imageDigest === undefined ||
      candidate === undefined ||
      finishedAt === undefined
    ) {
      return err(
        DeploymentError.of(
          "INVARIANT_VIOLATION",
          "A deployed deployment is missing the commit, image, container, or finish time it shipped with",
        ),
      );
    }

    const elapsed = finishedAt.since(this.fields.requestedAt);
    if (!elapsed.ok) {
      return elapsed;
    }

    return Release.create({
      id: releaseId,
      projectId: this.fields.projectId,
      deploymentId: this.fields.id,
      commitSha: resolvedSha,
      image,
      imageDigest,
      containerId: candidate.id,
      actor: this.fields.actor,
      deployedAt: finishedAt,
      duration: elapsed.value,
    });
  }

  // -- Serialization --------------------------------------------------------

  toSnapshot(): DeploymentSnapshot {
    return this.fields;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      id: this.fields.id,
      projectId: this.fields.projectId,
      trigger: this.fields.trigger,
      actor: this.fields.actor,
      targetRef: this.fields.targetRef,
      idempotencyKey: this.fields.idempotencyKey,
      requestedAt: this.fields.requestedAt.epochMillis,
      state: this.fields.state,
      lockEpoch: this.fields.lockEpoch ?? null,
      baseline: this.fields.baseline === undefined ? null : Baselines.toJSON(this.fields.baseline),
      resolvedSha: this.fields.resolvedSha ?? null,
      image: this.fields.image?.toString() ?? null,
      imageDigest: this.fields.imageDigest ?? null,
      candidate: this.fields.candidate?.toJSON() ?? null,
      healthCheckPassedAt: this.fields.healthCheckPassedAt?.epochMillis ?? null,
      routeVerifiedAt: this.fields.routeVerifiedAt?.epochMillis ?? null,
      interruptedFrom: this.fields.interruptedFrom ?? null,
      outcome: this.fields.outcome ?? null,
      error: this.fields.error?.toJSON() ?? null,
      finishedAt: this.fields.finishedAt?.epochMillis ?? null,
      warnings: this.fields.warnings.map((warning) => warning.toJSON()),
      transitions: this.fields.transitions.map((t) => ({
        from: t.from,
        to: t.to,
        at: t.at.epochMillis,
        reason: t.reason ?? null,
      })),
    };
  }

  // -- Internals ------------------------------------------------------------

  private next(patch: Partial<DeploymentFields>): Deployment {
    return new Deployment(Object.freeze({ ...this.fields, ...patch }));
  }

  /**
   * The single gate every state change passes through: the transition is legal, and
   * time has not gone backwards.
   *
   * There is no "already visited this state" check. The transition graph is acyclic
   * and one run follows one path through it, so a legal transition can never target a
   * state already visited — a guard here would be unreachable. Re-entry *is* checked
   * when loading a stored record, where a corrupted history can express it.
   */
  private transition(
    to: DeploymentState,
    at: Timestamp,
    patch: Partial<DeploymentFields> = {},
    reason?: string,
  ): Result<Deployment> {
    const legal = assertTransition(this.fields.state, to);
    if (!legal.ok) {
      return legal;
    }

    const timing = this.checkMonotonic(at);
    if (!timing.ok) {
      return timing;
    }

    const transitionRecord: StateTransition = Object.freeze({
      from: this.fields.state,
      to,
      at,
      reason,
    });

    return ok(
      this.next({
        ...patch,
        state: to,
        // Invariant: a terminal state always carries the time it ended.
        ...(isTerminal(to) ? { finishedAt: at } : {}),
        transitions: Object.freeze([...this.fields.transitions, transitionRecord]),
      }),
    );
  }

  /** A non-transitioning field update, valid only in specific states. */
  private mutate(
    operation: string,
    at: Timestamp,
    allowedStates: readonly DeploymentState[],
    patch: Partial<DeploymentFields>,
  ): Result<Deployment> {
    if (!allowedStates.includes(this.fields.state)) {
      return err(
        DeploymentError.of(
          "OPERATION_NOT_VALID_IN_STATE",
          `${operation} is not valid in state "${this.fields.state}" (expected ${allowedStates.join(" | ")})`,
          { details: { state: this.fields.state, operation } },
        ),
      );
    }
    const timing = this.checkMonotonic(at);
    if (!timing.ok) {
      return timing;
    }
    return ok(this.next(patch));
  }

  /** Time may not run backwards relative to the last recorded event. */
  private checkMonotonic(at: Timestamp): Result<Deployment> {
    const lastAt = this.lastEventAt();
    if (at.isBefore(lastAt)) {
      return err(
        DeploymentError.of(
          "NON_MONOTONIC_TIMESTAMP",
          `Timestamp ${at.toISOString()} precedes the deployment's last recorded event at ${lastAt.toISOString()}`,
          { details: { at: at.epochMillis, lastEventAt: lastAt.epochMillis } },
        ),
      );
    }
    return ok(this);
  }

  private lastEventAt(): Timestamp {
    const lastTransition = this.fields.transitions.at(-1);
    const lastStep = this.fields.steps.at(-1);
    let latest = this.fields.requestedAt;
    if (lastTransition !== undefined) {
      latest = Timestamp.max(latest, lastTransition.at);
    }
    if (lastStep !== undefined) {
      latest = Timestamp.max(
        latest,
        lastStep.status === "skipped" ? lastStep.at : lastStep.startedAt,
      );
    }
    return latest;
  }

  private requireInterrupted(): Result<Deployment> {
    return this.fields.state === "interrupted"
      ? ok(this)
      : err(
          DeploymentError.of(
            "OPERATION_NOT_VALID_IN_STATE",
            `Only an interrupted deployment can be reconciled (state is "${this.fields.state}")`,
            { details: { state: this.fields.state } },
          ),
        );
  }

  private rejectDuplicateStep(name: StepName): Result<Deployment> {
    return this.fields.steps.some((step) => step.name === name)
      ? err(
          DeploymentError.of(
            "OPERATION_NOT_VALID_IN_STATE",
            `Step "${name}" has already been recorded for this deployment`,
            { details: { step: name } },
          ),
        )
      : ok(this);
  }

  private withRunningStep(
    operation: string,
    transform: (running: RunningStep) => Result<StepRecord>,
  ): Result<Deployment> {
    const index = this.fields.steps.findIndex(isRunning);
    const running = this.fields.steps[index];
    if (running === undefined || !isRunning(running)) {
      return err(
        DeploymentError.of("OPERATION_NOT_VALID_IN_STATE", `${operation} requires a running step`, {
          details: { operation },
        }),
      );
    }
    const replaced = transform(running);
    if (!replaced.ok) {
      return replaced;
    }
    const steps = [...this.fields.steps];
    steps[index] = replaced.value;
    return ok(this.next({ steps: Object.freeze(steps) }));
  }
}
