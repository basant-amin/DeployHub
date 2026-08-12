/**
 * One authentication attempt, for the duration of one checkout.
 *
 * The two mechanisms have nothing in common at the command line — a token is an HTTPS credential
 * helper and a deploy key is an ssh invocation — so rather than branching inside every git call,
 * each produces the same three things: extra arguments, extra environment, and a way to clean up.
 * `CommandGitClient` then runs the same sequence of commands regardless of how the repository is
 * authenticated, which is what keeps the checkout pipeline free of authentication logic.
 *
 * Adding `github-app` is one more branch in `openAuthSession`: it is an HTTPS credential like the
 * token, differing only in where the value comes from and how long it lives.
 *
 * No session ever puts a secret in `extraArgs`. Argv is written to the deployment log; the
 * environment is not (`command-runner.ts`, `describe`).
 */

import { type Result, type SecretRef, err, ok } from "@/core/shared";
import type { GitAuth, Project } from "@/core/domain";
import type { SecretProvider } from "@/core/ports";

import { createSshIdentity } from "./ssh-key";

/** Read by the credential helper below. Never logged. */
const TOKEN_VARIABLE = "DEPLOYHUB_GIT_TOKEN";

/**
 * An inline helper rather than the credential in the URL.
 *
 * git would accept `https://x-access-token:<token>@host/repo`, but that URL is written into
 * `.git/config` on clone and echoed in progress output — so the token would outlive the command and
 * appear in the log. The helper reads it from the environment on demand instead.
 */
const CREDENTIAL_HELPER = `!f() { echo username=x-access-token; echo "password=$${TOKEN_VARIABLE}"; }; f`;

export interface AuthSession {
  /** Prepended to every git invocation. Contains no secret. */
  readonly extraArgs: readonly string[];
  /** Merged into the child's environment. May contain a secret. */
  readonly env: Readonly<Record<string, string>>;
  /** Called in a `finally`. Idempotent, and never throws. */
  readonly dispose: () => void;
}

/**
 * Build the session a project's configuration calls for.
 *
 * The method is read from configuration, not inferred from the URL — `DeployConfig` has already
 * refused a method that cannot work with the URL, so by this point the two agree and this function
 * does not have to re-litigate it.
 */
export async function openAuthSession(
  project: Project,
  secrets: SecretProvider,
): Promise<Result<AuthSession>> {
  const credential = await secrets.resolveCredential(project.config.gitCredentialRef);
  if (!credential.ok) {
    return credential;
  }

  const auth: GitAuth = project.config.gitAuth;

  switch (auth.method) {
    case "https-token":
      return ok({
        extraArgs: ["-c", `credential.helper=${CREDENTIAL_HELPER}`],
        env: { [TOKEN_VARIABLE]: credential.value },
        dispose: () => {},
      });

    case "ssh-deploy-key": {
      const knownHosts = await resolveKnownHosts(auth.knownHostsRef, secrets);
      if (!knownHosts.ok) {
        return knownHosts;
      }

      const identity = createSshIdentity(credential.value, knownHosts.value);
      if (!identity.ok) {
        return identity;
      }

      return ok({
        // No credential helper: git never consults one over SSH, and offering it would only make
        // the failure mode confusing.
        extraArgs: [],
        env: { GIT_SSH_COMMAND: identity.value.sshCommand },
        dispose: identity.value.dispose,
      });
    }
  }
}

/**
 * The host keys to verify against: the project's override, or the bundled ones.
 *
 * `undefined` means "use what is bundled", which is the normal case for github.com and needs no
 * project setting. An override that is configured but missing from the store is an error rather
 * than a silent fallback — an operator who set it is relying on it.
 */
async function resolveKnownHosts(
  ref: SecretRef | undefined,
  secrets: SecretProvider,
): Promise<Result<string | undefined>> {
  if (ref === undefined) {
    return ok(undefined);
  }
  const resolved = await secrets.resolveCredential(ref);
  return resolved.ok ? ok(resolved.value) : err(resolved.error);
}
