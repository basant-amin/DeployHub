/**
 * `Project` — the deployable unit.
 *
 * A project is identity plus configuration plus an on/off switch. It holds no
 * deployment history: a project does not know how many times it has been deployed,
 * because making it know would mean loading that history to answer any question
 * about it. Deployments reference a project, never the reverse.
 */

import {
  type ProjectId,
  type Result,
  DeploymentError,
  ProjectId as ProjectIdCodec,
  asRecord,
  combineFields,
  err,
  ok,
} from "@/core/shared";

import { DeployConfig } from "./deploy-config";
import { ProjectName, ProjectSlug } from "./project-name";

export interface ProjectInput {
  readonly id: unknown;
  readonly name: unknown;
  readonly slug: unknown;
  readonly config: unknown;
  /** Defaults to enabled — a project is created in order to deploy it. */
  readonly enabled?: unknown;
}

export class Project {
  private constructor(
    readonly id: ProjectId,
    readonly name: ProjectName,
    readonly slug: ProjectSlug,
    readonly config: DeployConfig,
    /**
     * A disabled project keeps its configuration and history but refuses new
     * deployments. This is how a project is taken out of service without
     * destroying the record of what it was.
     */
    readonly enabled: boolean,
  ) {}

  static create(raw: unknown): Result<Project> {
    const record = asRecord(raw, "PROJECT_INVALID", "Project");
    if (!record.ok) {
      return record;
    }
    const input = record.value as unknown as ProjectInput;

    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      return err(DeploymentError.of("PROJECT_INVALID", "Project enabled must be a boolean"));
    }

    const fields = combineFields("PROJECT_INVALID", "Invalid project", {
      id: ProjectIdCodec.parse(input.id),
      name: ProjectName.parse(input.name),
      slug: ProjectSlug.parse(input.slug),
      config: DeployConfig.create(input.config),
    });
    if (!fields.ok) {
      return fields;
    }

    return ok(
      new Project(
        fields.value.id,
        fields.value.name,
        fields.value.slug,
        fields.value.config,
        input.enabled ?? true,
      ),
    );
  }

  /** Whether a new deployment may be requested for this project. */
  get isDeployable(): boolean {
    return this.enabled;
  }

  /**
   * Gate a deployment request on the project's state.
   *
   * Returns the project so callers can chain, and a `PRECONDITION` failure rather
   * than a validation one when it is disabled — the request was well-formed, the
   * project simply is not accepting deployments.
   */
  ensureDeployable(): Result<Project> {
    return this.isDeployable
      ? ok(this)
      : err(
          DeploymentError.of(
            "PROJECT_DISABLED",
            `Project "${this.slug}" is disabled and cannot be deployed`,
            { details: { projectId: this.id, slug: this.slug } },
          ),
        );
  }

  enable(): Project {
    return this.enabled ? this : new Project(this.id, this.name, this.slug, this.config, true);
  }

  disable(): Project {
    return this.enabled ? new Project(this.id, this.name, this.slug, this.config, false) : this;
  }

  /** Identity comparison. Two projects are the same project iff their ids match. */
  equals(other: Project): boolean {
    return this.id === other.id;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      id: this.id,
      name: this.name,
      slug: this.slug,
      config: this.config.toJSON(),
      enabled: this.enabled,
    };
  }
}
