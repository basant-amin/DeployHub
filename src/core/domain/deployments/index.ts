/** The `deployments` bounded context: the lifecycle, and what it produces. */

export type { DeploymentState, LockDisposition } from "./deployment-state";
export {
  DEPLOYMENT_STATES,
  TRANSITIONS,
  assertTransition,
  canTransition,
  isActive,
  isTerminal,
  lockDisposition,
  releasesLock,
  requiresLock,
} from "./deployment-state";

export type { DeploymentOutcome, DeploymentTrigger } from "./deployment-trigger";
export {
  DEPLOYMENT_OUTCOMES,
  DEPLOYMENT_TRIGGERS,
  parseDeploymentTrigger,
} from "./deployment-trigger";

export type {
  FailedStep,
  RunningStep,
  SkippedStep,
  StepName,
  StepRecord,
  SucceededStep,
} from "./step";
export { STEP_NAMES, StepRecords, isRunning, isStepName } from "./step";

export { DeploymentWarning } from "./warning";

export type {
  Baseline,
  ExistingBaseline,
  ExistingBaselineInput,
  FirstDeployBaseline,
} from "./baseline";
export { Baselines, ProxyUpstream } from "./baseline";

export { CandidateContainer } from "./candidate";
export type { CandidateContainerInput } from "./candidate";

export { Release } from "./release";
export type { ReleaseInput } from "./release";

export { Deployment } from "./deployment";
export type {
  DeploymentFields,
  DeploymentRequestInput,
  DeploymentSnapshot,
  StateTransition,
} from "./deployment";

export {
  ensureNoActiveDeployment,
  findActiveDeployment,
  findByIdempotencyKey,
} from "./concurrency";

export { assessRollback } from "./rollback";
export type {
  RollbackAssessment,
  RollbackEligibility,
  RollbackEligible,
  RollbackRefusalReason,
  RollbackRefused,
} from "./rollback";
