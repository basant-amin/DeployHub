/**
 * Host keys for SSH git, pinned.
 *
 * `StrictHostKeyChecking=yes` needs something to check against, and a container has no
 * `~/.ssh/known_hosts` to inherit. The three answers were: accept the key on first use, which is
 * verification in name only; run `ssh-keyscan` at deploy time, which is the same thing with extra
 * steps; or ship the keys. Shipping them is the only one that actually authenticates the server, so
 * these are GitHub's published host keys, embedded rather than fetched.
 *
 * The consequence is a maintenance obligation, and it is the right one to accept: if GitHub rotates
 * a key and this list is stale, every deployment **fails closed** with `GIT_AUTH_FAILED` rather
 * than trusting an unverified host. `docs/docker.md` records how to update it, and `knownHostsRef`
 * is the escape hatch that does not require an image rebuild.
 *
 * Embedded as a constant rather than a data file so nothing has to be copied into the image at the
 * right path, and so the worker's tree carries it without a build step. These are public keys —
 * there is nothing secret here, and `RSA` is included because older clients still negotiate it.
 */

/**
 * `github.com`, as published at https://api.github.com/meta and in GitHub's SSH key fingerprints
 * documentation. Verified against the published SHA256 fingerprints:
 *
 *   ssh-ed25519       SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
 *   ecdsa-sha2-nistp256  SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM
 *   ssh-rsa           SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s
 */
export const GITHUB_HOST_KEYS: readonly string[] = Object.freeze([
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
]);

/**
 * The file contents to hand `UserKnownHostsFile`.
 *
 * A trailing newline matters: ssh ignores a final line without one, which would silently drop the
 * last key and make host-key verification depend on which algorithm was negotiated.
 */
export function knownHostsFileContents(override: string | undefined): string {
  const lines = override === undefined ? GITHUB_HOST_KEYS : [override.trim()];
  return `${lines.join("\n").trim()}\n`;
}
