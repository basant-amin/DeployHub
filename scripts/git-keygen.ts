/**
 * Provision an SSH deploy key for a project.
 *
 * The first step of onboarding a private repository, and the reason that step does not involve
 * hand-editing the file that holds every project's credentials:
 *
 *   npm run git:keygen -- --ref deployhub-demo.git.credentials
 *     → copy the printed public key
 *     → GitHub repo → Settings → Deploy keys → Add key, leave "Allow write access" unchecked
 *     → register the project with method ssh-deploy-key and the SSH clone URL
 *     → deploy
 *
 * On a server there is no Node — the runtime lives in the image — so it runs there through the
 * container that already mounts the secret store:
 *
 *   docker exec deployhub-worker node --experimental-transform-types \
 *     --import /opt/deployhub/scripts/register-alias.mjs \
 *     /opt/deployhub/scripts/git-keygen.ts --ref <slug>.git.credentials
 *
 * **The private key is never printed.** It goes from ssh-keygen into the secret store and nowhere
 * else — not to stdout, not to stderr, not into an error message. Only the public half is printed,
 * because that is the half that has to be copied somewhere.
 *
 * Which store it writes to comes from `DEPLOYHUB_ROOT`, the same variable the worker reads. The npm
 * script passes `--env-file-if-exists=.env.local` because a plain node process — unlike Next — loads
 * no env files, so without it this would write to a server's `/var/lib/deployhub` while the dev
 * server reads from the developer's own root. In the container the real environment supplies it and
 * there is no `.env.local`, which is why the flag tolerates a missing file.
 */

import { LocalCommandRunner } from "@/server/adapters/command-runner";
import { derivePublicKey, generateDeployKey } from "@/server/adapters/git/deploy-key";
import { FileSecretProvider } from "@/server/adapters/secrets/file-secret-provider";
import { writeCredential } from "@/server/adapters/secrets/secret-file-writer";
import { runtimeConfigFromEnv } from "@/server/runtime/composition";
import { SecretRef } from "@/core/shared";

interface Options {
  readonly ref: string;
  readonly force: boolean;
  readonly showPublic: boolean;
}

const USAGE = `Provision an SSH deploy key for a project.

  npm run git:keygen -- --ref <slug>.git.credentials
  npm run git:keygen -- --ref <slug>.git.credentials --force
  npm run git:keygen -- --ref <slug>.git.credentials --show-public

  --ref <secret-ref>   Where the private key is stored. Matches the project's
                       "Git credential" field; defaults to <slug>.git.credentials.
  --force              Replace an existing key. This invalidates the public key
                       already registered on the repository.
  --show-public        Print the public key for an existing entry and change nothing.

The private key is written into the secret store and is never printed.`;

function parse(argv: readonly string[]): Options | string {
  let ref: string | undefined;
  let force = false;
  let showPublic = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--ref": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
          return "--ref needs a secret reference, such as deployhub-demo.git.credentials";
        }
        ref = value;
        index += 1;
        break;
      }
      case "--force":
        force = true;
        break;
      case "--show-public":
        showPublic = true;
        break;
      case "-h":
      case "--help":
        return USAGE;
      default:
        return `unknown option ${String(argument)}\n\n${USAGE}`;
    }
  }

  if (ref === undefined) {
    return `--ref is required\n\n${USAGE}`;
  }
  return { ref, force, showPublic };
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parse(argv);
  if (typeof options === "string") {
    console.error(options);
    return options === USAGE ? 0 : 1;
  }

  // Validated before anything touches the store, so a typo cannot create a key under a reference
  // the platform would later refuse to read.
  const ref = SecretRef.parse(options.ref);
  if (!ref.ok) {
    console.error(`Invalid secret reference: ${ref.error.message}`);
    return 1;
  }

  const config = runtimeConfigFromEnv();
  const runner = new LocalCommandRunner();
  const comment = `deployhub:${ref.value}`;

  if (options.showPublic) {
    const stored = await new FileSecretProvider(config.secretsPath).resolveCredential(ref.value);
    if (!stored.ok) {
      console.error(stored.error.message);
      return 1;
    }
    const derived = await derivePublicKey(runner, stored.value, comment);
    if (!derived.ok) {
      console.error(derived.error.message);
      return 1;
    }
    console.log(derived.value);
    return 0;
  }

  const pair = await generateDeployKey(runner, comment);
  if (!pair.ok) {
    console.error(pair.error.message);
    return 1;
  }

  const written = writeCredential(config.secretsPath, ref.value, pair.value.privateKey, {
    force: options.force,
  });
  if (!written.ok) {
    // The generated key is dropped here rather than stored anywhere else. Nothing was registered on
    // GitHub yet, so discarding it costs nothing and leaves no orphan private key behind.
    console.error(written.error.message);
    return 1;
  }

  report(config.secretsPath, written.value.replaced, ref.value, pair.value.publicKey);
  return 0;
}

function report(storePath: string, replaced: boolean, ref: string, publicKey: string): void {
  console.log(`${replaced ? "Replaced" : "Stored"} the private key at "${ref}" in ${storePath}.\n`);
  console.log("Add this public key to the repository — Settings → Deploy keys → Add deploy key.");
  console.log('Leave "Allow write access" unchecked: deployment only ever reads.\n');
  console.log(publicKey);
  console.log(
    `\nThen register the project with the SSH clone URL (git@github.com:owner/repo.git),\nmethod ssh-deploy-key, and "${ref}" as its git credential.`,
  );
  if (replaced) {
    console.log(
      "\nThe previous key no longer works. Remove it from the repository's deploy keys once\nthis one is added, and redeploy to confirm.",
    );
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    // Never `console.error(cause)`: a stack trace from this command could carry key material in a
    // frame's arguments. Only the message, which the modules above construct without secrets.
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
