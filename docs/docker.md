# Running DeployHub in Docker

DeployHub deploys applications with Docker, and it is itself deployed with Docker. The Linux host
provides Docker Engine, git, nginx, SSH, and a firewall — and nothing else. No Node, no npm, no
process manager. Every application on the box, this one included, brings its own runtime in its
image.

This document is the operational contract for that image. The run command below is part of the
architecture rather than a convenience: **the image will not work correctly under default bridge
networking**, and the reason is worth reading before the first deployment.

---

## Container architecture

DeployHub is a host agent that happens to have a web interface. It drives the host's Docker
Engine, reads the host's disk, and probes ports the host's daemon published. Containerizing it
means deciding how much of the host it can still see.

**One image, two containers.** `deployhub-web` serves the dashboard; `deployhub-worker` runs
deployments. They are separate processes because a deployment takes minutes and must outlive the
request that triggered it ([D7](architecture/decisions.md#d7--the-engine-runs-in-a-long-lived-worker-not-a-request-handler)),
and separate containers rather than a supervised pair because `--restart unless-stopped` can then
restart either without touching the other. They share the data mount and the Docker socket, and
coordinate through SQLite in WAL mode — one writer, several readers.

**Ordinary bridge networking is enough.** That is a consequence of
[D12](architecture/decisions.md#d12--classic-replacement-stop-remove-run): every deployed container
publishes on a **fixed** host port and the host's proxy is never reconfigured, so nothing inside
DeployHub needs to address the host's loopback as if it were its own. The health probe targets the
published port, which the daemon binds on the host, and the worker reaches it the same way any
other client would.

```
Cloudflare
    │
    ▼
Linux host ────────────────────────────────────────────────────────────
  nginx :443 ──► 127.0.0.1:3000   OneCommunity container   (unchanged)
             └─► 127.0.0.1:8080   DeployHub dashboard
                        │
  ┌─────────────────────┴───────────┐   ┌──────────────────────────────┐
  │ deployhub-web       USER node   │   │ deployhub-worker  USER node  │
  │  node server.js  :3000          │   │  node worker.ts              │
  │  (published to 127.0.0.1:8080)  │   │  docker CLI + buildx, git    │
  └─────────────┬───────────────────┘   └──────┬───────────────┬───────┘
                │  /var/lib/deployhub          │               │
                └──────────────┬───────────────┘               │
                               ▼                     /var/run/docker.sock
                     deployhub.db (WAL)                        │
                     projects/<slug>/repo                      ▼
                     secrets.json                    Docker Engine (host)
                                                       builds images
                                                       stop → rm → run
                                                       one container per project
```

The containers run no daemon. They hold a Docker _client_ that asks the host's daemon to do
things. Images built during a deployment are the host's images; containers started are the host's
containers, published on their fixed ports exactly as a manual `docker run` would leave them.
Nothing DeployHub creates lives inside DeployHub's own containers, which is what makes them
disposable.

**Why nginx never has to change.** A deployment stops `one-community`, removes it, and starts a
new `one-community` publishing `3000:3000` again. From nginx's point of view nothing happened —
its `proxy_pass http://127.0.0.1:3000` was correct before and is correct after. DeployHub does not
read, write, or reload the host's proxy configuration, and has no adapter that could.

### Path identity

A container driving the host's daemon must be careful about which side resolves a path. Two cases,
both safe:

- **Build contexts** are read by the _client_ and streamed to the daemon, so `docker build` run
  from `/var/lib/deployhub/projects/<slug>/repo` resolves that path inside the container.
- **App containers** are started with `--publish` and `--env` only. The adapter never passes `-v`,
  so no path is handed to the daemon to resolve on the host side.

Mounting the data root at the **same path inside the container as on the host**
(`/var/lib/deployhub:/var/lib/deployhub`) keeps that true if a future change ever does pass a path
to the daemon. It costs nothing and removes a class of confusing failure.

## Image layout

Four stages; only the last one ships.

| Stage        | Base                         | Purpose                                              |
| ------------ | ---------------------------- | ---------------------------------------------------- |
| `docker-cli` | `docker:29.1.5-cli`          | Source of the pinned Docker client and buildx plugin |
| `deps`       | `node:24.18.1-bookworm-slim` | `npm ci --ignore-scripts`, cached on the lockfile    |
| `builder`    | `node:24.18.1-bookworm-slim` | `npm run build`, including the type check            |
| `runner`     | `node:24.18.1-bookworm-slim` | What ships                                           |

The runtime image contains: the Node 24 runtime, the traced dashboard (`server.js` plus the modules
Next's file tracing proved reachable) at `/app`, the worker's TypeScript sources at
`/opt/deployhub`, `git`, `ca-certificates`, the Docker CLI, and the buildx plugin. It contains no
npm install, no `next` binary, no test runner, no compiler, and no Docker daemon.

The worker's sources are the one thing in the image that is not compiled output. It runs them
directly under Node's type stripping — the same mechanism `npm run deployhub` uses — because the
alternative was a second build step whose output would be a third copy of the code to keep in step.
They live outside `/app` so they cannot collide with the sources Next's tracing places there.

**Why Node 24 specifically.** Persistence uses `node:sqlite`, the runtime's built-in driver
(`src/server/adapters/persistence/database.ts`). That is why this project has no native module to
compile and needs no build toolchain in the final image. `.nvmrc` and `engines.node` agree on 24.

**Why Debian rather than Alpine.** Preflight reads free disk with `df -Pk` and parses total from
column 2 and available from column 4 (`src/server/adapters/docker/container-runtime.ts`). GNU
coreutils on Debian produces exactly that layout, and matches the Ubuntu host the platform is
validated against; busybox's `df` is not guaranteed to. Alpine would save roughly 90 MB in exchange
for reintroducing a parsing risk the project has an open `[verify on Linux]` marker for. It is not a
good trade for the component whose job is to refuse a deployment when the disk is full. Confirmed
inside this image:

```
Filesystem     1024-blocks    Used Available Capacity Mounted on
overlay          474095688 5102172 444837308       2% /
```

**Why standalone output.** `next.config.ts` sets `output: "standalone"`. Measured, on the same
host, same base image, same tooling:

| Runtime model                            | Image size |
| ---------------------------------------- | ---------- |
| `next start` + production `node_modules` | 1.15 GB    |
| `node server.js` (standalone)            | **657 MB** |

`next start` requires the `next` package at runtime, which carries the SWC native binaries; the
image would ship a CLI in order to call one function. Standalone emits a traced module graph and a
`server.js`, so the runtime stage performs no install at all. The application payload is 22 MB of
the 657 MB, plus 2 MB of worker sources — the remainder is the Node runtime, git, and the Docker
tooling, all of which are irreducible given what DeployHub does.

**Why buildx is included.** `docker build` has routed through BuildKit via the buildx CLI plugin
since Docker 23. Without the plugin the engine's build step fails outright with _"the buildx
component is missing"_; there is no silent fallback. `docker-compose` is deliberately **not**
copied — DeployHub drives container lifecycle directly, and the plugin would be 30 MB of code
nothing can reach.

**Version pinning.** `NODE_VERSION` and `DOCKER_CLI_VERSION` are build args with concrete defaults,
never `latest`. The Docker _client_ is pinned to the 29.1.x line the adapters were verified against
(`docs/ops/host-spike.md`); a client older than the host's daemon is fine, because the CLI
negotiates the API version down. Bumping either is a deliberate, reviewable edit:

```
docker build --build-arg NODE_VERSION=24.18.1 --build-arg DOCKER_CLI_VERSION=29.1.5 -t deployhub:… .
```

---

## Build command

Run from the repository root on the server, on the commit being deployed:

```bash
docker build --tag deployhub:$(git rev-parse --short HEAD) --tag deployhub:current .
```

Tagging by commit is what makes the rollback procedure below possible: `deployhub:current` moves,
the sha tags do not. Keep at least the previous two.

Nothing is baked in at build time. There are no build secrets and no `NEXT_PUBLIC_*` values the
application reads, so the same image is valid in staging and in production — configuration arrives
entirely through the environment at `docker run`.

---

## Run command

Two containers from one image. The host must already have the data root and the secrets file in
place, owned by uid 1000 — see [Persistent storage](#persistent-storage).

### The dashboard

```bash
docker run --detach \
  --name deployhub-web \
  --restart unless-stopped \
  --init \
  --publish 127.0.0.1:8080:3000 \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(getent group docker | cut -d: -f3)" \
  --volume /var/lib/deployhub:/var/lib/deployhub \
  --env-file /etc/deployhub/deployhub.env \
  --log-opt max-size=10m --log-opt max-file=3 \
  deployhub:current
```

### The worker

```bash
docker run --detach \
  --name deployhub-worker \
  --restart unless-stopped \
  --init \
  --stop-timeout 1800 \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(getent group docker | cut -d: -f3)" \
  --volume /var/lib/deployhub:/var/lib/deployhub \
  --env-file /etc/deployhub/deployhub.env \
  --log-opt max-size=10m --log-opt max-file=3 \
  deployhub:current \
  node --experimental-transform-types --disable-warning=ExperimentalWarning \
       --import /opt/deployhub/scripts/register-alias.mjs /opt/deployhub/scripts/worker.ts
```

Every flag, because each is load-bearing:

| Flag                            | Why                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--restart unless-stopped`      | The host has no process manager. This replaces one, and it survives reboot. `unless-stopped` rather than `always` so a deliberate stop during maintenance is respected.          |
| `--init`                        | Reaps orphans. The command runner SIGKILLs a command that exceeds its timeout, and a killed `git` leaves grandchildren reparented to PID 1; Node does not reap unknown children. |
| `--publish 127.0.0.1:8080:3000` | **Web only.** Binds the dashboard to the host's loopback so nginx can reach it and nothing else can. Change `8080` if it is taken; the container side is always 3000.            |
| `--stop-timeout 1800`           | **Worker only.** On SIGTERM it finishes the deployment in flight. Docker's 10s default would SIGKILL it mid-build, leaving a container half-replaced for the boot sweep to find. |
| `--group-add <docker gid>`      | Grants the non-root `node` user access to the socket. Resolved from the host at run time — the gid differs between machines, so it must never be baked into the image.           |
| `-v …/docker.sock`              | The mechanism by which a containerized DeployHub controls host Docker. Both containers need it: the worker to deploy, the web process to read state for the dashboard.           |
| `-v /var/lib/deployhub:…`       | Same path both sides. Database, WAL/SHM, workspaces, secrets. Shared by both containers.                                                                                         |
| `--env-file`                    | Keeps `DEPLOYHUB_PASSWORD` out of the process table and shell history. Mode `0600`, root-owned, **outside the repository**.                                                      |
| `--log-opt max-size`            | Both are long-lived; uncapped JSON logs are a slow disk-full on the filesystem preflight guards.                                                                                 |

**On user:** deliberately no `--user`. The image sets `USER node` (uid 1000) already, and passing
`--user` wrongly is a way to lose the docker group membership. `--group-add` is what matters.

**On the worker's command:** it runs the TypeScript sources under Node's type stripping, the same
mechanism `npm run deployhub` uses. The long command line is the cost of having no bundler and no
second build output to keep in step. It needs no `node_modules` — everything it touches is `@/…`
source or a Node builtin.

**No Docker Compose**, deliberately. `docker build`, `docker run`, and nginx are the deployment
model, matching the existing OneCommunity infrastructure. DeployHub controls container lifecycle
directly rather than delegating it to Compose.

### nginx

nginx terminates TLS and proxies to the dashboard. This is an **additive** server block — the
OneCommunity block is not touched:

```nginx
location / {
    proxy_pass         http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
}
```

**DeployHub never modifies nginx.** Deployed containers publish on a fixed port, so the upstream
that was correct before a deployment is correct after it. There is no proxy adapter, no config
templating, and no reload — see
[D12](architecture/decisions.md#d12--classic-replacement-stop-remove-run).

### Required bind mounts

| Host path              | Container path         | Mode | Why                                                               |
| ---------------------- | ---------------------- | ---- | ----------------------------------------------------------------- |
| `/var/run/docker.sock` | `/var/run/docker.sock` | rw   | Build images, stop/remove/run containers, read the daemon version |
| `/var/lib/deployhub`   | `/var/lib/deployhub`   | rw   | SQLite database + WAL + SHM, project workspaces, secrets file     |

Both are mandatory, on both containers. Without the socket every deployment fails at preflight
with `DOCKER_UNAVAILABLE`; without the data mount the two containers do not share a database and
the deployment history dies with the container.

## Environment variables

Set in `/etc/deployhub/deployhub.env` (mode `0600`, root-owned). Defaults come from
`runtimeConfigFromEnv()`; the image sets the ones marked _(image)_.

| Variable                  | Default                        | Notes                                                                                                                 |
| ------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `DEPLOYHUB_PASSWORD`      | —                              | **Required.** Shared dashboard password, ≥8 chars. Unset ⇒ every route redirects to `/signin`. `openssl rand -hex 24` |
| `DEPLOYHUB_ACTOR`         | `dashboard`                    | Recorded as the actor on dashboard-triggered deployments                                                              |
| `DEPLOYHUB_ROOT`          | `/var/lib/deployhub` _(image)_ | Base for the three paths below                                                                                        |
| `DEPLOYHUB_DATABASE`      | `<root>/deployhub.db`          | SQLite file                                                                                                           |
| `DEPLOYHUB_WORKSPACES`    | `<root>/projects`              | One git checkout per project                                                                                          |
| `DEPLOYHUB_SECRETS`       | `<root>/secrets.json`          | Must be mode `0600` or the adapter refuses to read it                                                                 |
| `DEPLOYHUB_BIND_HOST`     | `127.0.0.1`                    | Interface **deployed containers** publish on. See below — this is the one to think about                              |
| `DEPLOYHUB_PUBLIC_SCHEME` | `https`                        | Scheme the host's proxy serves the public route on                                                                    |
| `DEPLOYHUB_PUBLIC_PORT`   | `443`                          | Port the host's proxy serves the public route on                                                                      |
| `DEPLOYHUB_STORAGE_PATH`  | `/var/lib/deployhub` _(image)_ | Overridden by the image; the code default would fail. See below                                                       |
| `DEPLOYHUB_LEASE_TTL_MS`  | `60000`                        | How long a deploy lease survives without a heartbeat                                                                  |
| `PORT`                    | `3000` _(image)_               | Port the dashboard binds                                                                                              |
| `HOSTNAME`                | `0.0.0.0` _(image)_            | Interface the dashboard binds **inside the container**. `--publish 127.0.0.1:8080:3000` is what confines it           |

**`DEPLOYHUB_BIND_HOST` decides who can reach a deployed application.** `127.0.0.1` publishes to
the host's loopback only, so the application is reachable exactly through nginx — the safer value,
and where new projects should land. `0.0.0.0` reproduces a plain `-p 3000:3000`, which is what an
existing deployment already does, and matching it exactly is what makes the first adoption of
OneCommunity a no-op rather than a change. Set it to `0.0.0.0` for the first validation, then
tighten to `127.0.0.1` once staging has confirmed nothing reaches the app directly.

It affects only the containers DeployHub _deploys_. The dashboard's own exposure is decided by
`--publish`, which is loopback-only in both cases.

**`DEPLOYHUB_STORAGE_PATH` is the one default the image has to change.** Preflight runs
`df -Pk <path>` and aborts the deployment if the command fails
(`deployment-engine.ts`, `readStorageHeadroom`). The code's default, `/var/lib/docker`, is correct
on a host and does not exist inside the image, so leaving it would refuse every deployment with
`COMMAND_FAILED`. Verified:

```
$ docker exec deployhub-worker df -Pk /var/lib/docker
df: /var/lib/docker: No such file or directory

$ docker exec deployhub-worker df -Pk /var/lib/deployhub | tail -1
/dev/vda1        474095688 6518136 443421344       2% /var/lib/deployhub
```

The bind-mounted data root is a real host filesystem, and on a single-volume server it is the same
one Docker's data root sits on — so the number preflight gets is the number it is asking for. If
`/var/lib/docker` is ever moved to a separate volume, bind-mount that path read-only and set this
variable back to it.

A starting `/etc/deployhub/deployhub.env`:

```
DEPLOYHUB_PASSWORD=<openssl rand -hex 24>
DEPLOYHUB_ACTOR=dashboard
DEPLOYHUB_PUBLIC_SCHEME=https
DEPLOYHUB_PUBLIC_PORT=443

# Matches OneCommunity's existing `-p 3000:3000` for the first validation.
# Tighten to 127.0.0.1 once staging confirms nothing reaches the app directly.
DEPLOYHUB_BIND_HOST=0.0.0.0
```

This file is **not** `.env`, is not in the repository, and is never copied into the image.
`.dockerignore` excludes `.env` and `.env.*` from the build context so it cannot happen by accident.

---

## Persistent storage

Everything DeployHub must not lose lives under one directory. Create it before the first run:

```bash
sudo mkdir -p /var/lib/deployhub/projects
sudo chown -R 1000:1000 /var/lib/deployhub
sudo chmod 750 /var/lib/deployhub

sudo install -o 1000 -g 1000 -m 600 /dev/null /var/lib/deployhub/secrets.json
echo '{}' | sudo -u '#1000' tee /var/lib/deployhub/secrets.json > /dev/null
```

`1000:1000` is the `node` user inside the image. Ownership matters twice: the process must be able
to write the database, and `FileSecretProvider` refuses to read a secrets file that any group or
other bit can reach, so `secrets.json` must be exactly `0600` **and** owned by 1000.

| Path                        | Contents                                                     |
| --------------------------- | ------------------------------------------------------------ |
| `deployhub.db`              | Projects, deployments, releases, leases, log lines           |
| `deployhub.db-wal`, `…-shm` | WAL sidecars. Must sit beside the database on the same mount |
| `projects/<slug>/repo`      | One git checkout per project                                 |
| `secrets.json`              | Secret values, mode `0600`, read-only to the platform        |

The database runs in WAL mode because the web process and the worker are separate processes sharing
one file. WAL requires the `-wal` and `-shm` sidecars to live on the same filesystem as the database
— which is why the whole directory is one bind mount rather than three, and why it must be a real
local filesystem, never NFS or a network share.

Deployment history and logs are rows in that database; they need no separate mount. Application
containers DeployHub starts are the host's containers and outlive DeployHub's own container.

---

## Docker socket access

The container reaches the host daemon over `/var/run/docker.sock`. On Ubuntu the socket is
`root:docker`, mode `0660`, so a non-root process needs the `docker` group:

```bash
--group-add "$(getent group docker | cut -d: -f3)"
```

Resolved from the host at run time and never baked into the image, because the gid differs between
machines and a hard-coded one silently fails as a permission error at the first deployment.

Verify after starting:

```bash
docker exec deployhub docker version --format '{{.Server.Version}}'
```

An empty result or _"permission denied while trying to connect to the Docker API"_ means the
`--group-add` value is wrong.

---

## Production deployment steps

Assumes the host hardening in `docs/internal/DEPLOYHUB_PROJECT_STATE.md` (steps 1–11) is done:
non-root sudo user, SSH keys, password auth disabled, ufw default-deny with 22/80/443 open and
**8080 closed**, Docker from Docker's own apt repository, git, nginx.

No new infrastructure is installed. The host gains no service it did not already run.

1. **Check the dashboard port is free**: `ss -ltnp | grep 8080`. Pick another if it is taken.
2. **Clone the repository** to `/opt/deployhub-src` (build location; not the data root, and not
   `/opt/deployhub`, which is where the image keeps the worker's sources).
3. **Create the data root and secrets file** — see [Persistent storage](#persistent-storage).
4. **Write `/etc/deployhub/deployhub.env`**, `chmod 600`, root-owned.
5. **Build the image** — see [Build command](#build-command).
6. **Start both containers** — see [Run command](#run-command).
7. **Verify the socket**: `docker exec deployhub-worker docker version --format '{{.Server.Version}}'`.
8. **Verify the worker is looping**: `docker logs deployhub-worker` shows `worker … started`.
9. **Verify the dashboard**: `curl -sI http://127.0.0.1:8080/signin` returns 200; `/` returns 307
   to `/signin`.
10. **Configure nginx** for the dashboard host — an additive server block — obtain a certificate,
    reload.
11. **Sign in** and register OneCommunity. Set **Container name** to `one-community` — the name
    the container already runs under — and **Container port** to `3000`. Both are read-only
    afterwards, because they address something already on the host.
12. **Confirm the firewall** still denies 8080 from outside.

## Upgrade procedure

The image is disposable; the data root is not. Nothing in these steps touches
`/var/lib/deployhub`.

```bash
cd /opt/deployhub-src
git fetch --all && git checkout <ref>

# Build first. A failed build must not take the running dashboard down.
docker build --tag deployhub:$(git rev-parse --short HEAD) --tag deployhub:next .

# Stop the worker first and give it time to finish anything in flight.
docker stop deployhub-worker
docker stop deployhub-web
docker rm deployhub-worker deployhub-web

docker tag deployhub:next deployhub:current
# Both run commands from above.
```

Build before stopping, always: a compile error then costs nothing, and the previous containers are
still serving while it happens.

**Stop the worker first, and let it drain.** `--stop-timeout 1800` gives it up to half an hour to
finish the deployment it is on. Killing it mid-deployment leaves a project with a half-replaced
container — recoverable by the boot sweep, but an outage until the next deployment.

Expect a short dashboard outage. DeployHub does not deploy itself with zero downtime, for the same
reason it does not deploy anything else that way: it would need a second instance and a proxy
switch. Deployed applications are unaffected — their containers are the host's and keep serving
throughout.

Verify afterwards: the dashboard answers, the deployment history is intact (proof the mount is
attached), the worker logs `worker … started`, and `docker exec deployhub-worker docker version`
reports a server version.

## Rollback procedure

Rolling DeployHub back is retagging, because the sha tags were kept:

```bash
docker stop deployhub-worker deployhub-web
docker rm deployhub-worker deployhub-web
docker tag deployhub:<previous-sha> deployhub:current
# Both run commands from above.
```

Two things this does **not** do, deliberately:

- **It does not roll back the database.** Schema creation is `create table if not exists` and there
  is no migration runner yet, so an older image reads a newer file happily today. The first change
  that rewrites existing rows breaks that property, and the answer then is to snapshot
  `/var/lib/deployhub` before upgrading. Until a migration runner exists, take the snapshot anyway.
- **It does not touch deployed applications.** Their containers are the host's and keep serving
  throughout. Rolling DeployHub back is not rolling a deployment back; that is the dashboard's
  rollback button, which is a different mechanism entirely.

Verified snapshot, taken with the container stopped:

```bash
sudo tar -czf /root/deployhub-$(date +%F).tar.gz -C /var/lib deployhub
```

---

## Security notes

### Mounting the Docker socket is granting root on the host

This is the single most important sentence in this document. `/var/run/docker.sock` is the daemon's
full control API, and the daemon runs as root. Anything that can reach it can start a container
with `--privileged`, or bind-mount `/` and write to it. There is no permission model inside that
socket: access is total, and it is equivalent to passwordless root.

Consequences that follow, and should not be argued away:

- **Running as `USER node` does not contain this.** The `node` user is in the `docker` group, and
  membership of the `docker` group is root-equivalent by design — this is documented Docker
  behaviour, not a misconfiguration. The non-root user is still worth having, for narrower reasons:
  files written into the bind mounts are owned by a known unprivileged uid rather than by root, and
  a defect that is _not_ a Docker call cannot write outside the mounts. Both are real. Neither is
  isolation.
- **The dashboard password is a root credential.** Anyone who can sign in can cause arbitrary
  `docker build` and `docker run` on the host. Treat `DEPLOYHUB_PASSWORD` exactly as you would the
  root password: long, random, in the team's secret store, rotated on any suspicion. A leaked
  session cookie is equally bad — the session is an HMAC of the password with no expiry, so
  rotating the password is what invalidates every cookie.
- **Therefore the dashboard must never be publicly reachable without TLS and a real reason.** It
  is published to `127.0.0.1` only, ufw denies 8080 inbound, and nginx terminates TLS. All three,
  not one.
- **Both containers hold the socket, so both are privileged.** The worker needs it to deploy; the
  web process needs it to read host state for the dashboard. Splitting them buys process
  separation and restart independence, not a privilege boundary.

The honest summary: DeployHub is a privileged host agent. The container is packaging, not a
sandbox. If a stronger boundary is ever needed, the answer is a socket proxy that allowlists API
endpoints, or rootless Docker — not a tighter `docker run` line.

### The rest

- **No secrets in the image.** `.dockerignore` excludes `.env`, `.env.*`, `secrets.json`, `*.db*`,
  and `.git` from the build context, so they cannot be copied even by a careless `COPY . .`. Runtime
  configuration arrives via `--env-file`; secret _values_ are read from the bind-mounted
  `secrets.json` at the moment they are used and are never cached in the image or the database.
- **No install-time script execution.** The build uses `npm ci --ignore-scripts`.
- **Pinned bases.** Concrete Node and Docker CLI versions, never `latest`, so an image rebuilt for a
  rollback is the image that was rolled back to.
- **Minimal runtime surface.** No npm, no `next` CLI, no test runner, no compiler, no Docker
  daemon. The worker's TypeScript sources are present under `/opt/deployhub` because it runs them
  directly; they are the same sources the image was built from, and they carry no secrets.
- **Secrets never enter argv.** The git credential helper reads the token from the environment,
  because a failed command's argv is written to the deployment log and its environment is not.
- **Nothing writes to the host's proxy config.** There is no adapter that could, which removes a
  whole class of risk that a config-rewriting deployment tool carries.

### No HEALTHCHECK, on purpose

The image declares none. A container health check should report whether the _application_ is
healthy, and this application has no endpoint that answers that question: every route is a dashboard
page behind the session gate, and the one unauthenticated route, `/signin`, renders without touching
SQLite or Docker — precisely the two dependencies whose failure matters. A probe that stays green
while the database is unreachable is worse than no probe, because it is trusted.

Under `docker run` a HEALTHCHECK would not restart anything either; only Swarm acts on health
status. `--restart unless-stopped` handles the case that is actually detectable, which is the
process exiting.

A truthful health endpoint would need to open the database, run a trivial query, and confirm the
Docker daemon answers `docker version` — and be exempted from the session gate while leaking
nothing. That is a small, well-defined piece of work, and inventing a fake one to satisfy a
`HEALTHCHECK` line would have been worse than leaving the line out.

---

## Known constraints

Things this architecture does not do, recorded so they are not rediscovered.

**Deployments are not zero-downtime.** The site is down from the moment the previous container is
stopped until the new one answers — seconds normally, longer if the new image crashes on boot.
This is [D12](architecture/decisions.md#d12--classic-replacement-stop-remove-run), chosen so that
DeployHub needs no control over the host's reverse proxy. Zero downtime returns as a strategy when
a project needs it, and D8 records the design.

**DeployHub does not deploy itself.** Its own upgrade is `docker stop`/`docker run` by hand, as
above.

**Cloudflare sits inside the deployment success path.** The post-promotion check probes
`https://<route.host>` with `User-Agent: DeployHub/health-check`. If Cloudflare answers 403 — Bot
Fight Mode, a WAF rule, Under Attack mode — the engine reads a failed verification and **rolls back
a deployment that actually worked**. Allowlist that User-Agent, or point `DEPLOYHUB_PUBLIC_*` at the
origin, before the first real deployment.

**No migration runner.** Schema creation is `create table if not exists`, so an older image reads a
newer database happily today. The first change that rewrites existing rows ends that. Snapshot
`/var/lib/deployhub` before every upgrade until one exists.

**The CLI is not in the runtime image.** `scripts/deployhub.ts` needs devDependencies for its
imports; the worker's tree carries only what the worker touches. Operate through the dashboard.

**No multi-project UI yet.** The engine and the domain support several — each project carries its
own container name and port — but the dashboard resolves "the project" as `projects[0]`. Registering
a second project needs that resolved first, and two projects must not share a published port.
