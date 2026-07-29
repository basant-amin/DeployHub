# Host spike — verified commands

Every command and payload below was executed against a real Docker daemon (29.1.2), a real
Caddy (2.11.4), and real git (2.46.1) before any adapter was written. The adapters use these
exact forms. Nothing here is inferred from documentation.

**Where this was verified:** macOS 15 / arm64, Docker Desktop, Caddy native. The Docker CLI,
Caddy admin API, and git surfaces are identical on Linux. Two things are _not_ and must be
re-verified on the target server before production — they are marked **[verify on Linux]**.

---

## Docker

### Build

```
docker build --quiet --file <dockerfilePath> --tag <repo>:<sha> \
  --label deployhub.project=<slug> \
  --label deployhub.deployment=<deploymentId> \
  --label deployhub.commit=<sha> \
  --label deployhub.actor=<actor> \
  <buildContext>
```

### The image digest of a locally built image

`RepoDigests` is populated only for images pulled from or pushed to a registry. DeployHub
builds on the host it deploys to, so the digest it records is the image **ID**, which is the
sha256 of the image config and satisfies the domain's `ImageDigest` shape:

```
$ docker image inspect spike/app:v1 --format '{{.Id}}'
sha256:198c3692673b7b298a11c7bd8583b6187905a6b2cf5474f5915779436e34e01c
```

That is the identity a rollback resolves, and it is stable for identical content.

### Run a candidate

The host port is **allocated by Docker**, not chosen by DeployHub — an empty host port in
`-p 127.0.0.1::<containerPort>` binds an ephemeral port on loopback only, so a candidate is
unreachable from outside until Caddy is pointed at it.

```
docker run --detach --name <slug>-<deploymentId> --restart unless-stopped \
  --label deployhub.project=<slug> --label deployhub.deployment=<id> \
  --label deployhub.commit=<sha> --label deployhub.digest=<digest> \
  --env KEY=VALUE ... \
  --publish 127.0.0.1::<containerPort> \
  <repo>:<sha>
```

### Inspect — the only source of structured state

```
$ docker inspect <id> --format '{{json .State}}'
{"Status":"running","Running":true,"Paused":false,"Restarting":false,"OOMKilled":false,
 "Dead":false,"Pid":4300,"ExitCode":0,"Error":"","StartedAt":"…","FinishedAt":"…"}

$ docker inspect <id> --format '{{json .NetworkSettings.Ports}}'
{"8000/tcp":[{"HostIp":"127.0.0.1","HostPort":"63670"}]}
```

The adapter reads one JSON document per container (`docker inspect --format '{{json .}}'`)
and takes `Name`, `State.Status`, `State.ExitCode`, `State.Restarting`, `RestartCount`,
`Config.Labels`, `Config.Image`, `Image`, and `NetworkSettings.Ports`.

`Status` values mapped to the port's `ContainerState`: `created` → starting, `running` →
running (or restarting when `State.Restarting`), `restarting` → restarting, `exited`/`dead` →
exited with `ExitCode`, `paused`/`removing` → stopped.

### Listing containers without parsing `docker ps`

```
$ docker container ls -aq --filter label=deployhub.project=spike
6572859e9466
```

`-q` emits bare ids, one per line — there are no columns to parse. Every id is then passed to
`docker inspect`, which is the only place structured data comes from.

### Stop, remove, prune

```
docker stop --timeout <seconds> <id>
docker rm <id>
docker image rm <digest>          # exactly the digests the retention policy names
```

### Free disk **[verify on Linux]**

```
$ df -Pk /var/lib/docker | tail -1
/dev/disk3s5  482797652  ...  29082184  ...
```

`-P` forces one line per filesystem and `-k` forces 1024-byte blocks, which is the POSIX
form. Fields: total is column 2, available column 4, both in KiB. macOS and GNU coreutils
agree on this under `-P`; the column _order_ is what needs confirming on the target.

### Two things only integration found

The commands above were verified before the adapters were written. These two were found by the
first real deployment, which is the argument for doing one before declaring the adapters done.

**The admin API refuses `fetch` where it accepts curl.** Caddy enforces origin safety and rejects
a request whose `Origin` header is present but not allowed. `curl` sends no `Origin` at all and is
permitted; `fetch` sends an empty one, which reads as untrusted:

```
$ node -e 'fetch("http://localhost:2019/config/…")'
403 {"error":"client is not allowed to access from origin ''"}

# with Origin set to the admin address
200 [":8080"]
```

So the adapter sends `Origin: <adminUrl>` on every call. Verified against 2.11.4.

**`docker build` must run in the project workspace.** `dockerfilePath` and `buildContext` are
workspace-relative, and the worker's own working directory is wherever it was started:

```
ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory
```

The workspace path is now one shared definition (`src/server/adapters/workspace.ts`) used by both
the git and docker adapters, so the two cannot disagree about where the source is.

---

## Caddy admin API

No config file templating, no reload command, no `caddy` binary invocation at runtime. Three
HTTP calls against `http://localhost:2019`.

### Bootstrap config (written once, at install)

```json
{
  "admin": { "listen": "localhost:2019" },
  "apps": {
    "http": {
      "servers": {
        "main": {
          "listen": [":8080"],
          "routes": [],
          "automatic_https": { "disable": true }
        }
      }
    }
  }
}
```

**`automatic_https.disable` is load-bearing in development and must be removed in
production.** With a host matcher present and auto-HTTPS on, Caddy provisions certificates
and binds `:80` for the ACME challenge; on a machine already using `:80` the whole config
apply fails with:

```
{"error":"loading new config: http app module: start: listening on :80: bind: address already in use"}
```

The adapter is unaffected either way — it only ever addresses the upstream by `@id` — so
production uses `"listen": [":443"]` with auto-HTTPS enabled and changes nothing in code.

### Create the route for a project — once, on first deployment

`POST` to an array path appends to it.

```
POST http://localhost:2019/config/apps/http/servers/main/routes
{
  "@id": "deployhub-route-<slug>",
  "match": [{ "host": ["<route host>"] }],
  "handle": [{
    "@id": "deployhub-upstream-<slug>",
    "handler": "reverse_proxy",
    "upstreams": [{ "dial": "127.0.0.1:<port>" }]
  }]
}
→ 200
```

### Read the current upstream

```
$ curl -s http://localhost:2019/id/deployhub-upstream-spike
{"@id":"deployhub-upstream-spike","handler":"reverse_proxy","upstreams":[{"dial":"127.0.0.1:63670"}]}
```

When the route does not exist yet:

```
{"error":"unknown object ID 'deployhub-upstream-spike'"}
```

That 404-with-body is how the adapter distinguishes "no previous release" from "cannot reach
Caddy", which is what makes `Baselines.firstDeploy()` reachable.

### Switch the upstream

```
PATCH http://localhost:2019/id/deployhub-upstream-<slug>
{"@id":"deployhub-upstream-<slug>","handler":"reverse_proxy","upstreams":[{"dial":"127.0.0.1:<newPort>"}]}
→ 200
```

Verified to actually move traffic: after PATCHing from port 63670 to 63694 and then
**stopping** the container on 63670, the public route still served the application. Caddy
validates and applies atomically — a rejected config leaves the previous routing intact,
which is the property the rollback path depends on.

---

## Git

```
git clone --quiet <url> <workspace>                      # first use only
git -C <workspace> remote set-url origin <url>           # in case config changed
git -C <workspace> fetch --prune --tags --quiet origin
```

Resolving a ref to a commit, trying the remote branch first so `main` means `origin/main`:

```
$ git -C ws rev-parse --verify --quiet "refs/remotes/origin/main^{commit}"
960d062ba69a2a7e1d434e465c392c5a14f3e592
$ git -C ws rev-parse --verify --quiet "7f80f20d…^{commit}"      # the rollback case
7f80f20d99d4adcc55feae668069c033d27cceaa
```

```
git -C <workspace> checkout --detach --force --quiet <sha>
git -C <workspace> clean -qfdx
```

A full `fetch --tags` before resolving is what makes an arbitrary sha reachable, so a
rollback to an old commit needs no special server support.

### Credentials never appear in argv

The resolved token is passed in the **environment** and read by an inline credential helper,
so it is absent from the command line the runner logs:

```
git -c credential.helper='!f() { echo username=x-access-token; echo "password=$DEPLOYHUB_GIT_TOKEN"; }; f' …
```

For `ssh://` and `git@…` remotes the helper is never invoked and the host's own SSH key is
used. Local paths and `file://` need no credential at all.

---

## Health probe assumptions

- The candidate is probed at `http://127.0.0.1:<allocated port><path>` — reachable because
  DeployHub runs **on** the target server. This is the assumption that removes SSH from the
  MVP entirely, and the one that breaks first when a second server appears.
- The public route is probed at `<scheme>://<route host>:<public port><path>`. `PublicRoute`
  carries no port, so the scheme and port Caddy serves on are adapter configuration
  (`http` / `8080` in development, `https` / `443` in production).
- A probe is one request with a timeout. Connection refused, reset, and timeout are all
  reported as `unreachable` with a reason; any HTTP response is `responded` with its status.
  The policy decides what that means.

---

## Test application used for the spike

A 20-line Alpine image whose `/healthz` returns `$HEALTH_STATUS` (default 200) and a body of
`DEPLOYHUB-OK`. Setting `HEALTH_STATUS=503` makes a deployment fail its health check on
demand, which is how the rollback path is demonstrated end to end rather than argued for.

Checking the **body**, not just the status, matters: Caddy answers `200` with an empty body
when no route matches, so a status-only assertion passes against a proxy that is not
proxying anything.
