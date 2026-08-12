/**
 * `GitAuth` — how DeployHub proves it may read a repository.
 *
 * The method is **explicit configuration**, not something derived from the repository URL. It could
 * be derived today, because each of the two methods maps onto exactly one transport — but that
 * stops being true the moment a GitHub App arrives, since an installation token and a personal
 * token both travel over HTTPS. Recording the method means the later addition is one more enum
 * member rather than a second authentication redesign, and it means the answer to "how does this
 * project authenticate" is a stored fact an operator can audit rather than an inference.
 *
 * Per-method settings live inside this object rather than beside it, which is what keeps the
 * extension additive: `github-app` brings its own fields here and nothing outside changes shape.
 *
 * There is no secret value here. The credential is at `DeployConfig.gitCredentialRef` and stays a
 * pointer, so a project record can be logged, serialized, and persisted without leaking anything.
 *
 * Errors are reported as `DEPLOY_CONFIG_INVALID` rather than a code of their own. The error
 * catalogue is closed and each code has exactly one producer; this object has no life outside a
 * deploy config, so a separate code would name a producer that does not exist independently.
 */

import {
  type GitTransport,
  type Result,
  type SecretRef,
  DeploymentError,
  SecretRef as SecretRefCodec,
  asRecord,
  checkCrossField,
  err,
  ok,
} from "@/core/shared";

const CODE = "DEPLOY_CONFIG_INVALID";

/**
 * The methods release 1 supports.
 *
 * `ssh-deploy-key` is the recommended production method: a deploy key is scoped to one repository
 * and can be read-only, so onboarding a client's private repository never requires anyone's
 * personal access token. `https-token` is retained for compatibility and for hosts where deploy
 * keys are not available.
 *
 * `github-app` is deliberately absent. It is the intended third method, and this shape is what
 * makes adding it additive.
 */
export const GIT_AUTH_METHODS = ["ssh-deploy-key", "https-token"] as const;

export type GitAuthMethod = (typeof GIT_AUTH_METHODS)[number];

/** The transport each method can actually authenticate over. */
const TRANSPORT_FOR: Readonly<Record<GitAuthMethod, GitTransport>> = {
  "ssh-deploy-key": "ssh",
  "https-token": "https",
};

export interface GitAuthInput {
  readonly method: unknown;
  /** Optional override for host-key verification. Only meaningful for SSH. */
  readonly knownHostsRef?: unknown;
}

export class GitAuth {
  private constructor(
    readonly method: GitAuthMethod,
    /**
     * Pointer to a `known_hosts` file contents, for a host DeployHub does not ship keys for —
     * GitHub Enterprise, a self-hosted server, or a deliberate override.
     *
     * Absent is the normal case, not an incomplete configuration: the SSH adapter uses its bundled
     * pinned github.com host keys. What is never an option is skipping verification.
     */
    readonly knownHostsRef: SecretRef | undefined,
  ) {}

  /**
   * The reading of a project saved before the method was recorded.
   *
   * Every such project used an HTTPS token, because that was the only mechanism the git adapter
   * had. So this is not a guess about intent — it is the only value that could have been true, and
   * an existing project keeps working with no migration.
   */
  static legacyDefault(): GitAuth {
    return new GitAuth("https-token", undefined);
  }

  static create(raw: unknown): Result<GitAuth> {
    const record = asRecord(raw, CODE, "Git authentication");
    if (!record.ok) {
      return record;
    }
    const input = record.value as unknown as GitAuthInput;

    const method = parseMethod(input.method);
    if (!method.ok) {
      return method;
    }

    // Absent and empty are the same thing here: the form submits "" for a field nobody filled in,
    // and an empty override is not an override.
    const wantsOverride = input.knownHostsRef !== undefined && input.knownHostsRef !== "";
    if (!wantsOverride) {
      return ok(new GitAuth(method.value, undefined));
    }

    const knownHostsRef = SecretRefCodec.parse(input.knownHostsRef);
    if (!knownHostsRef.ok) {
      return err(
        DeploymentError.validation(CODE, "Invalid git authentication", [
          `knownHostsRef: ${knownHostsRef.error.message}`,
        ]),
      );
    }

    const auth = new GitAuth(method.value, knownHostsRef.value);

    // Rejected rather than ignored. A setting that is silently unused is a setting an operator
    // believes is in effect, and host-key configuration is the wrong place to be mistaken.
    const issues =
      method.value === "ssh-deploy-key"
        ? []
        : [
            `knownHostsRef: only applies to ssh-deploy-key, but this project authenticates with ${method.value}`,
          ];

    return checkCrossField(CODE, "Invalid git authentication", auth, issues);
  }

  /** The transport this method requires. */
  get transport(): GitTransport {
    return TRANSPORT_FOR[this.method];
  }

  equals(other: GitAuth): boolean {
    return this.method === other.method && this.knownHostsRef === other.knownHostsRef;
  }

  /**
   * Omits `knownHostsRef` when unset rather than writing `null`.
   *
   * `create` then reads its own output identically to a config written before the field existed,
   * which is what makes a round trip through the database lossless.
   */
  toJSON(): Readonly<Record<string, unknown>> {
    return this.knownHostsRef === undefined
      ? { method: this.method }
      : { method: this.method, knownHostsRef: this.knownHostsRef };
  }
}

function parseMethod(raw: unknown): Result<GitAuthMethod> {
  if (typeof raw !== "string") {
    return err(
      DeploymentError.validation(CODE, "Invalid git authentication", ["method: must be a string"]),
    );
  }
  const value = raw.trim();
  if (!(GIT_AUTH_METHODS as readonly string[]).includes(value)) {
    return err(
      DeploymentError.validation(CODE, "Invalid git authentication", [
        `method: must be one of ${GIT_AUTH_METHODS.join(" | ")}${value === "" ? "" : ` (received "${value}")`}`,
      ]),
    );
  }
  return ok(value as GitAuthMethod);
}
