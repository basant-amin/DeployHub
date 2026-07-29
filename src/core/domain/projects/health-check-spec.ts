/**
 * `HealthCheckSpec` — what "healthy" means for one project.
 *
 * The spec is data; evaluating it is policy in `core/application/policies`, and
 * performing a single probe is an adapter. Keeping the three apart is what makes
 * the platform's most-tuned numbers reviewable in one place instead of hidden
 * behind a network call (see `docs/architecture/decisions.md` § D9).
 */

import {
  type Result,
  Duration,
  UrlPath,
  asRecord,
  checkCrossField,
  combineFields,
  parseInteger,
} from "@/core/shared";

/** Probes closer together than this add load without adding information. */
const MIN_INTERVAL_MILLIS = 100;
const MAX_INTERVAL_MILLIS = 60_000;
const MIN_BUDGET_MILLIS = 1_000;
const MAX_BUDGET_MILLIS = 1_800_000;
const MAX_CONSECUTIVE_PASSES = 20;

export interface HealthCheckSpecInput {
  readonly path: unknown;
  readonly expectedStatus: unknown;
  readonly intervalMillis: unknown;
  readonly requiredConsecutivePasses: unknown;
  readonly totalBudgetMillis: unknown;
}

export class HealthCheckSpec {
  private constructor(
    readonly path: UrlPath,
    readonly expectedStatus: number,
    readonly interval: Duration,
    /**
     * Consecutive passes required. Above one, a service that flaps
     * pass/fail/pass is never promoted — which is the entire reason the field
     * exists rather than being hard-coded to one.
     */
    readonly requiredConsecutivePasses: number,
    readonly totalBudget: Duration,
  ) {}

  static create(raw: unknown): Result<HealthCheckSpec> {
    const record = asRecord(raw, "HEALTH_CHECK_SPEC_INVALID", "Health check spec");
    if (!record.ok) {
      return record;
    }
    const input = record.value as unknown as HealthCheckSpecInput;

    const fields = combineFields("HEALTH_CHECK_SPEC_INVALID", "Invalid health check spec", {
      path: UrlPath.parse(input.path),
      expectedStatus: parseInteger(input.expectedStatus, {
        label: "Expected status",
        code: "HEALTH_CHECK_SPEC_INVALID",
        min: 100,
        max: 599,
      }),
      interval: intervalOf(input.intervalMillis),
      requiredConsecutivePasses: parseInteger(input.requiredConsecutivePasses, {
        label: "Required consecutive passes",
        code: "HEALTH_CHECK_SPEC_INVALID",
        min: 1,
        max: MAX_CONSECUTIVE_PASSES,
      }),
      totalBudget: budgetOf(input.totalBudgetMillis),
    });
    if (!fields.ok) {
      return fields;
    }

    const { path, expectedStatus, interval, requiredConsecutivePasses, totalBudget } = fields.value;
    const spec = new HealthCheckSpec(
      path,
      expectedStatus,
      interval,
      requiredConsecutivePasses,
      totalBudget,
    );

    // The one rule a per-field check cannot express: a spec whose budget cannot
    // accommodate the passes it demands is not strict, it is impossible. The first
    // probe runs immediately, so N passes need N-1 intervals.
    const issues: string[] = [];
    if (spec.minimumTimeToPass.isLongerThan(totalBudget)) {
      issues.push(
        `totalBudgetMillis (${totalBudget.millis}) is shorter than the ${spec.minimumTimeToPass.millis}ms needed for ${requiredConsecutivePasses} consecutive passes at a ${interval.millis}ms interval, so the check can never pass`,
      );
    }
    if (totalBudget.isShorterThan(interval)) {
      issues.push(
        `totalBudgetMillis (${totalBudget.millis}) is shorter than intervalMillis (${interval.millis})`,
      );
    }

    return checkCrossField("HEALTH_CHECK_SPEC_INVALID", "Invalid health check spec", spec, issues);
  }

  /** Earliest the check could possibly succeed: the first probe is immediate. */
  get minimumTimeToPass(): Duration {
    return this.interval.times(this.requiredConsecutivePasses - 1);
  }

  /** Whether a probe's response status counts as a pass. */
  accepts(status: number): boolean {
    return status === this.expectedStatus;
  }

  equals(other: HealthCheckSpec): boolean {
    return (
      this.path === other.path &&
      this.expectedStatus === other.expectedStatus &&
      this.interval.equals(other.interval) &&
      this.requiredConsecutivePasses === other.requiredConsecutivePasses &&
      this.totalBudget.equals(other.totalBudget)
    );
  }

  toJSON(): {
    readonly path: string;
    readonly expectedStatus: number;
    readonly intervalMillis: number;
    readonly requiredConsecutivePasses: number;
    readonly totalBudgetMillis: number;
  } {
    return {
      path: this.path,
      expectedStatus: this.expectedStatus,
      intervalMillis: this.interval.millis,
      requiredConsecutivePasses: this.requiredConsecutivePasses,
      totalBudgetMillis: this.totalBudget.millis,
    };
  }
}

function intervalOf(raw: unknown): Result<Duration> {
  const millis = parseInteger(raw, {
    label: "Health check interval in milliseconds",
    code: "HEALTH_CHECK_SPEC_INVALID",
    min: MIN_INTERVAL_MILLIS,
    max: MAX_INTERVAL_MILLIS,
  });
  return millis.ok ? Duration.fromMillis(millis.value) : millis;
}

function budgetOf(raw: unknown): Result<Duration> {
  const millis = parseInteger(raw, {
    label: "Health check total budget in milliseconds",
    code: "HEALTH_CHECK_SPEC_INVALID",
    min: MIN_BUDGET_MILLIS,
    max: MAX_BUDGET_MILLIS,
  });
  return millis.ok ? Duration.fromMillis(millis.value) : millis;
}
