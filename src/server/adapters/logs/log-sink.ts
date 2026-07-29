/**
 * `DeploymentLogSink` — append-only lines in SQLite, read by polling.
 *
 * No streaming, no file handles, no rotation. One table keyed by `(deployment_id, seq)`, which
 * makes "give me everything after line N" an index seek — and polling that is what the
 * dashboard does instead of holding a connection open.
 *
 * **Redaction happens here and only here.** `open` binds the redactor built from the secrets
 * resolved for that deployment, and every line appended afterwards passes through it. That is
 * the point of the lifecycle: a dozen places write log lines, and one place stores them, so an
 * adapter cannot leak a credential by forgetting to redact.
 *
 * A write that fails is a warning on the deployment, never a failed deployment. The record is
 * the source of truth for what happened; the log is a diagnostic artifact beside it.
 */

import type { DatabaseSync } from "node:sqlite";

import {
  type DeploymentId,
  type Redactor,
  type Result,
  DeploymentError,
  Timestamp,
  err,
  ok,
} from "@/core/shared";
import { type StepName, isStepName } from "@/core/domain";
import type { DeploymentLogLine, DeploymentLogSink, LogStream } from "@/core/ports";

interface LineRow {
  readonly at: number;
  readonly step: string;
  readonly stream: string;
  readonly text: string;
}

/** Beyond this a deployment's log is truncated with a marker rather than growing forever. */
const MAX_LINES_PER_DEPLOYMENT = 20_000;

export class SqliteLogSink implements DeploymentLogSink {
  /** One redactor per open deployment. A worker runs one deployment at a time today. */
  private readonly redactors = new Map<string, Redactor>();

  constructor(private readonly database: DatabaseSync) {}

  async open(deploymentId: DeploymentId, redactor: Redactor): Promise<Result<void>> {
    this.redactors.set(deploymentId, redactor);
    try {
      this.database
        .prepare(
          `insert into log_state (deployment_id, completed) values (?, 0)
           on conflict(deployment_id) do update set completed = 0`,
        )
        .run(deploymentId);
      return ok(undefined);
    } catch (cause) {
      return err(storageFailure("open the log", cause));
    }
  }

  async append(deploymentId: DeploymentId, line: DeploymentLogLine): Promise<Result<void>> {
    const redactor = this.redactors.get(deploymentId);
    if (redactor === undefined) {
      // Refusing is deliberate: appending without a redactor would be an unredacted write, and
      // a missing line is far better than a leaked credential.
      return err(
        DeploymentError.of(
          "INVARIANT_VIOLATION",
          `The log for ${deploymentId} was not opened, so nothing can be appended to it`,
          { details: { deploymentId } },
        ),
      );
    }

    try {
      const next = this.nextSequence(deploymentId);
      if (next > MAX_LINES_PER_DEPLOYMENT) {
        if (next === MAX_LINES_PER_DEPLOYMENT + 1) {
          this.insert(deploymentId, next, {
            ...line,
            stream: "system",
            text: `[log truncated at ${MAX_LINES_PER_DEPLOYMENT} lines]`,
          });
        }
        return ok(undefined);
      }
      this.insert(deploymentId, next, { ...line, text: redactor.redact(line.text) });
      return ok(undefined);
    } catch (cause) {
      return err(storageFailure("append to the log", cause));
    }
  }

  async complete(deploymentId: DeploymentId): Promise<Result<void>> {
    this.redactors.delete(deploymentId);
    try {
      this.database
        .prepare(
          `insert into log_state (deployment_id, completed) values (?, 1)
           on conflict(deployment_id) do update set completed = 1`,
        )
        .run(deploymentId);
      return ok(undefined);
    } catch (cause) {
      return err(storageFailure("complete the log", cause));
    }
  }

  async read(deploymentId: DeploymentId): Promise<Result<readonly DeploymentLogLine[]>> {
    try {
      const rows = this.database
        .prepare(
          "select at, step, stream, text from log_lines where deployment_id = ? order by seq",
        )
        .all(deploymentId) as unknown as readonly LineRow[];
      return ok(rows.flatMap((row) => toLine(row) ?? []));
    } catch (cause) {
      return err(storageFailure("read the log", cause));
    }
  }

  /**
   * Historical lines, then whatever arrives until the log is completed.
   *
   * Implemented by polling the same table the dashboard polls — there is no second mechanism
   * here, and the port's shape does not commit anyone to one.
   */
  async *tail(deploymentId: DeploymentId): AsyncIterable<DeploymentLogLine> {
    let after = 0;
    for (;;) {
      const rows = this.database
        .prepare(
          `select seq, at, step, stream, text from log_lines
           where deployment_id = ? and seq > ? order by seq`,
        )
        .all(deploymentId, after) as unknown as readonly (LineRow & { readonly seq: number })[];

      for (const row of rows) {
        after = row.seq;
        const line = toLine(row);
        if (line !== undefined) {
          yield line;
        }
      }

      if (this.isCompleted(deploymentId)) {
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref();
      });
    }
  }

  private insert(deploymentId: DeploymentId, seq: number, line: DeploymentLogLine): void {
    this.database
      .prepare(
        `insert into log_lines (deployment_id, seq, at, step, stream, text)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(deploymentId, seq, line.at.epochMillis, line.step, line.stream, line.text);
  }

  private nextSequence(deploymentId: DeploymentId): number {
    const row = this.database
      .prepare("select coalesce(max(seq), 0) as last from log_lines where deployment_id = ?")
      .get(deploymentId) as unknown as { readonly last: number } | undefined;
    return (row?.last ?? 0) + 1;
  }

  private isCompleted(deploymentId: DeploymentId): boolean {
    const row = this.database
      .prepare("select completed from log_state where deployment_id = ?")
      .get(deploymentId) as unknown as { readonly completed?: number } | undefined;
    return row?.completed === 1;
  }
}

/** A row whose step or stream is unrecognisable is dropped rather than guessed at. */
function toLine(row: LineRow): DeploymentLogLine | undefined {
  const at = Timestamp.fromEpochMillis(row.at);
  if (!at.ok || !isStepName(row.step) || !isStream(row.stream)) {
    return undefined;
  }
  return {
    at: at.value,
    step: row.step satisfies StepName,
    stream: row.stream,
    text: row.text,
  };
}

function isStream(value: string): value is LogStream {
  return value === "stdout" || value === "stderr" || value === "system";
}

function storageFailure(what: string, cause: unknown): DeploymentError {
  return DeploymentError.of(
    "STORAGE_FAILED",
    `Could not ${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}
