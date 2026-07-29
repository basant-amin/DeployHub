/**
 * Aggregate ↔ JSON.
 *
 * The one genuinely intricate part of persistence, and the cost of choosing a snapshot column
 * over a relational model — a cost worth paying once here rather than in four tables forever.
 *
 * Two rules make it safe:
 *
 * **Everything is rebuilt through the domain.** Value objects come back through their parsers
 * and step records through `StepRecords`, so a row cannot become an aggregate that the domain
 * would have refused to construct. Reconstitution finishes at `Deployment.rehydrate`, which
 * re-checks every consistency rule — a snapshot corrupted by a bad edit or a future schema
 * change is rejected here rather than resumed as a deployment that skipped its health check.
 *
 * **Nothing is hand-assembled.** There is no object literal cast to a `StepRecord`. Where the
 * domain offers only a start-then-finish path, this code walks it.
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
  type Result,
  type ErrorCode,
  Actor as ActorCodec,
  CommitSha as CommitShaCodec,
  DeploymentError,
  ERROR_CATALOG,
  DeploymentId as DeploymentIdCodec,
  Duration,
  GitRef as GitRefCodec,
  IdempotencyKey as IdempotencyKeyCodec,
  ImageDigest as ImageDigestCodec,
  ImageReference,
  LockEpoch as LockEpochCodec,
  ProjectId as ProjectIdCodec,
  Timestamp,
  err,
  ok,
} from "@/core/shared";
import {
  type Baseline,
  type DeploymentOutcome,
  type DeploymentSnapshot,
  type DeploymentState,
  type DeploymentTrigger,
  type StateTransition,
  type StepName,
  type StepRecord,
  DEPLOYMENT_STATES,
  Baselines,
  CandidateContainer,
  Deployment,
  DeploymentWarning,
  Project,
  Release,
  StepRecords,
  isStepName,
  parseDeploymentTrigger,
} from "@/core/domain";

/**
 * Guards for the two unions a stored row carries as bare strings.
 *
 * Written here rather than added to the frozen layers: the codec is the only thing that reads
 * an untrusted state name or error code, so this is where the check belongs.
 */
function isDeploymentState(value: unknown): value is DeploymentState {
  return typeof value === "string" && (DEPLOYMENT_STATES as readonly string[]).includes(value);
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, value);
}

// -- Project ----------------------------------------------------------------

/**
 * `Project.toJSON()` already emits exactly the raw shape `Project.create` accepts, so a project
 * round-trips with no bespoke codec at all.
 */
export function encodeProject(project: Project): string {
  return JSON.stringify(project.toJSON());
}

export function decodeProject(snapshot: string): Result<Project> {
  const parsed = parseJson(snapshot, "project");
  return parsed.ok ? Project.create(parsed.value) : parsed;
}

// -- Release ----------------------------------------------------------------

export function encodeRelease(release: Release): string {
  return JSON.stringify(release.toJSON());
}

export function decodeRelease(snapshot: string): Result<Release> {
  const parsed = parseJson(snapshot, "release");
  if (!parsed.ok) {
    return parsed;
  }
  const raw = parsed.value as Record<string, unknown>;
  const deployedAt = Timestamp.fromEpochMillis(raw.deployedAt);
  if (!deployedAt.ok) {
    return deployedAt;
  }
  const duration = Duration.fromMillis(raw.durationMillis);
  if (!duration.ok) {
    return duration;
  }
  return Release.create({
    id: raw.id,
    projectId: raw.projectId,
    deploymentId: raw.deploymentId,
    commitSha: raw.commitSha,
    image: raw.image,
    imageDigest: raw.imageDigest,
    containerId: raw.containerId,
    actor: raw.actor,
    deployedAt: deployedAt.value,
    duration: duration.value,
  });
}

// -- Deployment -------------------------------------------------------------

/**
 * Encode the aggregate's own snapshot.
 *
 * `Deployment.toJSON()` is not used: it is a *view* for logs and drops the step records
 * entirely. Persistence needs everything, so this walks `toSnapshot()`.
 */
export function encodeDeployment(deployment: Deployment): string {
  const fields = deployment.toSnapshot();
  return JSON.stringify({
    id: fields.id,
    projectId: fields.projectId,
    trigger: fields.trigger,
    actor: fields.actor,
    targetRef: fields.targetRef,
    idempotencyKey: fields.idempotencyKey,
    requestedAt: fields.requestedAt.epochMillis,
    state: fields.state,
    lockEpoch: fields.lockEpoch ?? null,
    baseline: fields.baseline === undefined ? null : Baselines.toJSON(fields.baseline),
    resolvedSha: fields.resolvedSha ?? null,
    image: fields.image?.toString() ?? null,
    imageDigest: fields.imageDigest ?? null,
    candidate: fields.candidate?.toJSON() ?? null,
    healthCheckPassedAt: fields.healthCheckPassedAt?.epochMillis ?? null,
    routeVerifiedAt: fields.routeVerifiedAt?.epochMillis ?? null,
    interruptedFrom: fields.interruptedFrom ?? null,
    outcome: fields.outcome ?? null,
    error: fields.error?.toJSON() ?? null,
    finishedAt: fields.finishedAt?.epochMillis ?? null,
    warnings: fields.warnings.map((warning) => warning.toJSON()),
    steps: fields.steps.map(encodeStep),
    transitions: fields.transitions.map((transition) => ({
      from: transition.from,
      to: transition.to,
      at: transition.at.epochMillis,
      reason: transition.reason ?? null,
    })),
  });
}

export function decodeDeployment(snapshot: string): Result<Deployment> {
  const parsed = parseJson(snapshot, "deployment");
  if (!parsed.ok) {
    return parsed;
  }
  const raw = parsed.value as Record<string, unknown>;

  const id = DeploymentIdCodec.parse(raw.id);
  const projectId = ProjectIdCodec.parse(raw.projectId);
  const trigger = parseDeploymentTrigger(raw.trigger);
  const actor = ActorCodec.parse(raw.actor);
  const targetRef = GitRefCodec.parse(raw.targetRef);
  const idempotencyKey = IdempotencyKeyCodec.parse(raw.idempotencyKey);
  const requestedAt = Timestamp.fromEpochMillis(raw.requestedAt);
  if (
    !id.ok ||
    !projectId.ok ||
    !trigger.ok ||
    !actor.ok ||
    !targetRef.ok ||
    !idempotencyKey.ok ||
    !requestedAt.ok
  ) {
    return malformed("deployment", "a required field did not parse");
  }

  const state = asState(raw.state);
  if (!state.ok) {
    return state;
  }

  const baseline = decodeBaseline(raw.baseline);
  if (!baseline.ok) {
    return baseline;
  }
  const candidate = decodeCandidate(raw.candidate);
  if (!candidate.ok) {
    return candidate;
  }
  const steps = decodeSteps(raw.steps);
  if (!steps.ok) {
    return steps;
  }
  const warnings = decodeWarnings(raw.warnings);
  if (!warnings.ok) {
    return warnings;
  }
  const transitions = decodeTransitions(raw.transitions);
  if (!transitions.ok) {
    return transitions;
  }

  const fields: DeploymentSnapshot = {
    id: id.value satisfies DeploymentId,
    projectId: projectId.value satisfies ProjectId,
    trigger: trigger.value satisfies DeploymentTrigger,
    actor: actor.value satisfies Actor,
    targetRef: targetRef.value satisfies GitRef,
    idempotencyKey: idempotencyKey.value satisfies IdempotencyKey,
    requestedAt: requestedAt.value,
    state: state.value,
    lockEpoch: optional(raw.lockEpoch, (value) => LockEpochCodec.parse(value)) satisfies
      LockEpoch | undefined,
    baseline: baseline.value,
    resolvedSha: optional(raw.resolvedSha, (value) => CommitShaCodec.parse(value)) satisfies
      CommitSha | undefined,
    image: optional(raw.image, (value) => ImageReference.parse(value)),
    imageDigest: optional(raw.imageDigest, (value) => ImageDigestCodec.parse(value)) satisfies
      ImageDigest | undefined,
    candidate: candidate.value,
    healthCheckPassedAt: optional(raw.healthCheckPassedAt, (v) => Timestamp.fromEpochMillis(v)),
    routeVerifiedAt: optional(raw.routeVerifiedAt, (v) => Timestamp.fromEpochMillis(v)),
    interruptedFrom: optional(raw.interruptedFrom, asState),
    outcome: asOutcome(raw.outcome),
    error: decodeError(raw.error),
    finishedAt: optional(raw.finishedAt, (v) => Timestamp.fromEpochMillis(v)),
    warnings: warnings.value,
    steps: steps.value,
    transitions: transitions.value,
  };

  // The final gate: every consistency rule, re-checked.
  return Deployment.rehydrate(fields);
}

// -- Pieces -----------------------------------------------------------------

function encodeStep(step: StepRecord): Record<string, unknown> {
  if (step.status === "skipped") {
    return { status: step.status, name: step.name, at: step.at.epochMillis, reason: step.reason };
  }
  return {
    status: step.status,
    name: step.name,
    startedAt: step.startedAt.epochMillis,
    attempts: step.attempts,
    finishedAt: step.status === "running" ? null : step.finishedAt.epochMillis,
    error: step.status === "failed" ? step.error.toJSON() : null,
  };
}

/**
 * Rebuild step records by walking the domain's own path: start, retry to the recorded attempt
 * count, then succeed or fail. Nothing is cast into shape.
 */
function decodeSteps(raw: unknown): Result<readonly StepRecord[]> {
  if (!Array.isArray(raw)) {
    return ok([]);
  }
  const records: StepRecord[] = [];

  for (const entry of raw as readonly Record<string, unknown>[]) {
    const name = entry.name;
    if (!isStepName(name)) {
      return malformed("deployment", `unknown step name ${String(name)}`);
    }

    if (entry.status === "skipped") {
      const at = Timestamp.fromEpochMillis(entry.at);
      if (!at.ok) {
        return at;
      }
      records.push(StepRecords.skip(name, at.value, String(entry.reason ?? "")));
      continue;
    }

    const startedAt = Timestamp.fromEpochMillis(entry.startedAt);
    if (!startedAt.ok) {
      return startedAt;
    }
    let running = StepRecords.start(name, startedAt.value);
    const attempts = typeof entry.attempts === "number" ? entry.attempts : 1;
    for (let attempt = 1; attempt < attempts; attempt += 1) {
      running = StepRecords.retry(running);
    }

    if (entry.status === "running") {
      records.push(running);
      continue;
    }

    const finishedAt = Timestamp.fromEpochMillis(entry.finishedAt);
    if (!finishedAt.ok) {
      return finishedAt;
    }
    if (entry.status === "failed") {
      const error = decodeError(entry.error);
      if (error === undefined) {
        return malformed("deployment", `failed step ${name} has no error`);
      }
      const failed = StepRecords.fail(running, finishedAt.value, error);
      if (!failed.ok) {
        return failed;
      }
      records.push(failed.value);
      continue;
    }

    const succeeded = StepRecords.succeed(running, finishedAt.value);
    if (!succeeded.ok) {
      return succeeded;
    }
    records.push(succeeded.value);
  }

  return ok(records);
}

function decodeBaseline(raw: unknown): Result<Baseline | undefined> {
  if (raw === null || raw === undefined) {
    return ok(undefined);
  }
  const record = raw as Record<string, unknown>;
  if (record.kind === "first_deploy") {
    return ok(Baselines.firstDeploy());
  }
  const upstream = (record.upstream ?? {}) as Record<string, unknown>;
  return Baselines.existing({
    containerId: record.containerId,
    containerName: record.containerName,
    image: record.image,
    imageDigest: record.imageDigest,
    commitSha: record.commitSha,
    upstream: { host: upstream.host, port: upstream.port },
  });
}

function decodeCandidate(raw: unknown): Result<CandidateContainer | undefined> {
  if (raw === null || raw === undefined) {
    return ok(undefined);
  }
  const record = raw as Record<string, unknown>;
  const upstream = (record.upstream ?? {}) as Record<string, unknown>;
  const candidate = CandidateContainer.create({
    id: record.id,
    name: record.name,
    upstream: { host: upstream.host, port: upstream.port },
  });
  return candidate.ok ? ok(candidate.value) : candidate;
}

function decodeWarnings(raw: unknown): Result<readonly DeploymentWarning[]> {
  if (!Array.isArray(raw)) {
    return ok([]);
  }
  const warnings: DeploymentWarning[] = [];
  for (const entry of raw as readonly Record<string, unknown>[]) {
    const at = Timestamp.fromEpochMillis(entry.at);
    if (!at.ok) {
      return at;
    }
    const code = entry.code;
    if (!isErrorCode(code)) {
      return malformed("deployment", `unknown warning code ${String(code)}`);
    }
    const step = entry.step;
    warnings.push(
      DeploymentWarning.create(
        code,
        String(entry.message ?? ""),
        at.value,
        isStepName(step) ? (step satisfies StepName) : undefined,
      ),
    );
  }
  return ok(warnings);
}

function decodeTransitions(raw: unknown): Result<readonly StateTransition[]> {
  if (!Array.isArray(raw)) {
    return ok([]);
  }
  const transitions: StateTransition[] = [];
  for (const entry of raw as readonly Record<string, unknown>[]) {
    const from = asState(entry.from);
    const to = asState(entry.to);
    const at = Timestamp.fromEpochMillis(entry.at);
    if (!from.ok) return from;
    if (!to.ok) return to;
    if (!at.ok) return at;
    transitions.push({
      from: from.value,
      to: to.value,
      at: at.value,
      reason: typeof entry.reason === "string" ? entry.reason : undefined,
    });
  }
  return ok(transitions);
}

function decodeError(raw: unknown): DeploymentError | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const code = record.code;
  if (!isErrorCode(code)) {
    return undefined;
  }
  const issues = Array.isArray(record.issues) ? record.issues.map(String) : [];
  const step = typeof record.step === "string" ? record.step : undefined;
  const details =
    typeof record.details === "object" && record.details !== null
      ? (record.details as Record<string, unknown>)
      : {};
  return DeploymentError.of(code, String(record.message ?? ""), {
    issues,
    ...(step === undefined ? {} : { step }),
    details,
  });
}

// -- Helpers ----------------------------------------------------------------

function asState(raw: unknown): Result<DeploymentState> {
  return isDeploymentState(raw) ? ok(raw) : malformed("deployment", `unknown state ${String(raw)}`);
}

function asOutcome(raw: unknown): DeploymentOutcome | undefined {
  return raw === "deployed" || raw === "no_change" ? raw : undefined;
}

/** A null column becomes `undefined`; anything unparseable becomes `undefined` too. */
function optional<T>(raw: unknown, parse: (value: unknown) => Result<T>): T | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const parsed = parse(raw);
  return parsed.ok ? parsed.value : undefined;
}

function parseJson(snapshot: string, what: string): Result<unknown> {
  try {
    return ok(JSON.parse(snapshot));
  } catch {
    return malformed(what, "the stored snapshot is not valid JSON");
  }
}

function malformed<T>(what: string, why: string): Result<T> {
  return err(
    DeploymentError.of("STORAGE_FAILED", `Stored ${what} is unusable: ${why}`, {
      details: { what },
    }),
  );
}
