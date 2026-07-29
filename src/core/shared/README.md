# `core/shared` — domain kernel

The vocabulary the rest of `core/` is written in. This is the bottom of the
dependency graph: it imports nothing else in `src/`, contains no business rules, and
performs no I/O.

| Module           | Contents                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `result.ts`      | `Result<T, E>` — expected failures as values. `ok`, `err`, and one escape hatch           |
| `error-codes.ts` | The eight failure classes and the code catalog; a code declares its class once            |
| `errors.ts`      | `DeploymentError` — one error type, always coded, always classified                       |
| `validation.ts`  | `parseString` / `parseInteger` / `combineFields` — reports every bad field, not the first |
| `codec.ts`       | Codec factories, so a new value object is a two-line declaration                          |
| `brand.ts`       | Nominal typing for primitives                                                             |
| `ids.ts`         | `ProjectId`, `DeploymentId`, `ReleaseId` — distinct types, never generated here           |
| `time.ts`        | `Timestamp`, `Duration`. The domain never reads a clock                                   |
| `git.ts`         | `GitRepositoryUrl`, `GitRef`, `CommitSha` — a ref is a request, a sha is an answer        |
| `container.ts`   | `ContainerId`, `ContainerName`, `ContainerPort`                                           |
| `image.ts`       | `ImageReference` (reassignable) and `ImageDigest` (content, immutable)                    |
| `network.ts`     | `Hostname`                                                                                |
| `path.ts`        | `RelativePath`, `UrlPath` — traversal rejected here, not in an adapter                    |
| `secret-ref.ts`  | `SecretRef` — a pointer to a credential, never the credential                             |
| `lock-epoch.ts`  | `LockEpoch` — the fencing token, carried but never issued here                            |
| `redaction.ts`   | `Redactor` — known values plus shape patterns, applied once at the log boundary           |

`result.testing.ts` holds `expectOk` / `expectErr` for tests only; nothing in
production imports it.

Import from the barrel (`@/core/shared`), not individual files.

## Two rules worth knowing before adding to this layer

**The error catalog contains no code without a producer.** A code nobody raises is an
untested guess about its own classification. Adapter codes (SSH, Docker, git, proxy,
preflight) arrive with their adapters.

**Redaction over-redacts rather than partially redacting.** An unquoted secret runs to
the next structural delimiter, not the next space. A log line missing one extra word is
cosmetic; a log line containing one word of a password is an incident.

Full boundary: [`docs/architecture/modules.md`](../../../docs/architecture/modules.md#coreshared--domain-kernel).
