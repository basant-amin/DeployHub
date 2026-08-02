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

DeployHub is a host agent that happens to have a web interface. It does not merely run _next to_
Docker; it drives the host's Docker Engine, reads the host's disk, and probes ports the host's
daemon allocated. Containerizing it therefore means deciding how much of the host it can still see.

Three couplings force the answer.

**The candidate health check.** The engine publishes each candidate container on
`--publish 127.0.0.1::<containerPort>`, letting the host daemon allocate a free port, then probes it
at `http://127.0.0.1:<allocatedPort>` (`src/server/adapters/health/health-probe.ts`). The address is
the host's loopback. Inside a bridge-networked container, `127.0.0.1` is the container's own
loopback, so that probe would find nothing — and because health-before-promotion is invariant 4,
**every deployment would fail at the health check** rather than degrade quietly.

**The Caddy admin API.** The reverse-proxy adapter drives `http://localhost:2019`, which is
deliberately bound to loopback so the most dangerous endpoint on the box is not routable. Reaching
it from a bridge network would mean rebinding it to the docker0 gateway — widening exposure of the
one endpoint that can repoint production traffic.

**The public-route verification.** After promotion the engine re-probes the deployment through its
real public URL. That check is only meaningful if it traverses the same path an external client
would.

All three are satisfied, with no application change whatsoever, by running with
**`--network host`**. The container shares the host's network namespace, so `127.0.0.1` means the
host, `localhost:2019` reaches Caddy, and the public probe leaves and re-enters the box exactly as a
browser's request does. Every default in `runtimeConfigFromEnv()`
(`src/server/runtime/composition.ts`) is then correct as written.

The cost is that the container gets no network isolation. That cost is close to zero here, because
the same container is handed the Docker socket — see [Security notes](#security-notes). Network
isolation on top of socket access is a lock on a door in a wall that is not there.

```
Linux host ────────────────────────────────────────────────────────────
  nginx :80/:443 ──► 127.0.0.1:3000  (DeployHub dashboard)
                                │
  ┌─────────────────────────────┴──────────────────────────────┐
  │ container: deployhub   --network host   USER node (1000)   │
  │                                                            │
  │   node server.js  ── Next standalone, binds 127.0.0.1:3000 │
  │   docker CLI + buildx ──────────┐                          │
  │   git ──────────────┐           │                          │
  └─────────────────────┼───────────┼──────────────────────────┘
        bind mounts     │           │  /var/run/docker.sock
                        ▼           ▼
        /var/lib/deployhub    Docker Engine (host)
          deployhub.db          builds images
          deployhub.db-wal      runs app containers on 127.0.0.1:<alloc>
          deployhub.db-shm            │
          projects/<slug>/repo        ▼
          secrets.json          Caddy :2019 admin ──► public route :443
```

The container runs no daemon. It holds a Docker _client_ that asks the host's daemon to do things.
Images built during a deployment are the host's images; containers started are the host's
containers. Nothing DeployHub creates lives inside DeployHub's own container, which is what makes
the container disposable.

### Path identity

A container that drives the host's daemon has to be careful about which side resolves a path. Two
cases, both already safe:

- **Build contexts** are read by the _client_ and streamed to the daemon, so `docker build` run from
  `/var/lib/deployhub/projects/<slug>/repo` resolves that path inside the container. Correct.
- **App containers** are started with `--publish` and `--env` only. The adapter never passes `-v`,
  so no path is ever handed to the daemon to resolve on the host side.

Mounting the data root at the **same path inside the container as on the host**
(`/var/lib/deployhub:/var/lib/deployhub`) keeps that property true if a future change ever does pass
a path to the daemon. It costs nothing and removes a whole class of confusing failure, so the run
command below does it deliberately rather than mapping to a different container path.

---

## Image layout

Four stages; only the last one ships.

| Stage        | Base                         | Purpose                                              |
| ------------ | ---------------------------- | ---------------------------------------------------- |
| `docker-cli` | `docker:29.1.5-cli`          | Source of the pinned Docker client and buildx plugin |
| `deps`       | `node:24.18.1-bookworm-slim` | `npm ci --ignore-scripts`, cached on the lockfile    |
| `builder`    | `node:24.18.1-bookworm-slim` | `npm run build`, including the type check            |
| `runner`     | `node:24.18.1-bookworm-slim` | What ships                                           |

The runtime image contains: the Node 24 runtime, the traced application (`server.js` plus the
modules Next's file tracing proved reachable), `git`, `ca-certificates`, the Docker CLI, and the
buildx plugin. It contains no npm install, no `next` binary, no TypeScript, no test runner, no
source tree, and no Docker daemon.

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
| `node server.js` (standalone)            | **655 MB** |

`next start` requires the `next` package at runtime, which carries the SWC native binaries; the
image would ship a CLI in order to call one function. Standalone emits a traced module graph and a
`server.js`, so the runtime stage performs no install at all. The application payload is 22 MB of
the 655 MB — the remainder is the Node runtime, git, and the Docker tooling, all of which are
irreducible given what DeployHub does.

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

The host must first have the data root and the secrets file in place, owned by uid 1000 (the `node`
user inside the image) — see [Persistent storage](#persistent-storage).

```bash
docker run --detach \
  --name deployhub \
  --restart unless-stopped \
  --network host \
  --group-add "$(getent group docker | cut -d: -f3)" \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume /var/lib/deployhub:/var/lib/deployhub \
  --env-file /etc/deployhub/deployhub.env \
  --log-opt max-size=10m --log-opt max-file=3 \
  deployhub:current
```

Line by line, because every one of them is load-bearing:

| Flag                       | Why                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--restart unless-stopped` | The host has no process manager. This is what replaces one, and it survives reboot.                                                                                    |
| `--network host`           | Candidate health checks, the Caddy admin API, and public-route verification all address the host's loopback. See [Container architecture](#container-architecture).    |
| `--group-add <docker gid>` | Grants the non-root `node` user access to the socket. Resolved from the host at run time — the gid differs between machines, so it must never be baked into the image. |
| `-v …/docker.sock`         | The entire mechanism by which a containerized DeployHub controls host Docker.                                                                                          |
| `-v /var/lib/deployhub:…`  | Same path on both sides. Database, WAL/SHM, workspaces, secrets.                                                                                                       |
| `--env-file`               | Keeps `DEPLOYHUB_PASSWORD` out of the process table and out of shell history. Mode `0600`, root-owned, **outside the repository**.                                     |
| `--log-opt max-size`       | The dashboard is long-lived; uncapped JSON logs are a slow disk-full.                                                                                                  |

There is **no `-p`**: under host networking the server binds `PORT` on the host directly. The image
sets `HOSTNAME=127.0.0.1`, so the dashboard is reachable only through loopback and nginx must be the
thing that fronts it. That is a bind, not just a firewall rule — the dashboard is not exposed even
if ufw is misconfigured.

There is **no `docker-compose.yml`**, deliberately. `docker build`, `docker run`, and nginx are the
deployment model, matching the existing OneCommunity infrastructure. DeployHub controls container
lifecycle directly rather than delegating it to Compose.

### nginx

nginx terminates TLS and proxies to the dashboard. The minimum that works:

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
}
```

> **This is nginx in front of DeployHub only.** DeployHub's `ReverseProxy` adapter drives **Caddy**
> through its admin API, and Caddy is what routes traffic to the applications DeployHub deploys.
> Those are two different jobs. Caddy must still be installed and its admin API bound to
> `localhost:2019` before any _deployment_ can promote a candidate; nginx has no admin API and
> cannot substitute. See [Known constraints](#known-constraints).

### Required bind mounts

| Host path              | Container path         | Mode | Why                                                                  |
| ---------------------- | ---------------------- | ---- | -------------------------------------------------------------------- |
| `/var/run/docker.sock` | `/var/run/docker.sock` | rw   | Build images, start/stop/inspect containers, read the daemon version |
| `/var/lib/deployhub`   | `/var/lib/deployhub`   | rw   | SQLite database + WAL + SHM, project workspaces, secrets file        |

Both are mandatory. Without the socket every deployment fails at preflight with `DOCKER_UNAVAILABLE`;
without the data mount the deployment history is written into the container's writable layer and is
destroyed by the next upgrade.

---

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
| `DEPLOYHUB_CADDY_ADMIN`   | `http://localhost:2019`        | Correct as-is under `--network host`                                                                                  |
| `DEPLOYHUB_CADDY_SERVER`  | `main`                         | Server key inside `apps.http.servers`                                                                                 |
| `DEPLOYHUB_BIND_HOST`     | `127.0.0.1`                    | Where candidates publish, and therefore where they are probed. Correct as-is under `--network host`                   |
| `DEPLOYHUB_PUBLIC_SCHEME` | `https`                        | Scheme Caddy serves the public route on                                                                               |
| `DEPLOYHUB_PUBLIC_PORT`   | `443`                          | Port Caddy serves the public route on                                                                                 |
| `DEPLOYHUB_STORAGE_PATH`  | `/var/lib/deployhub` _(image)_ | Overridden by the image; the code default would fail. See below                                                       |
| `DEPLOYHUB_LEASE_TTL_MS`  | `60000`                        | How long a deploy lease survives without a heartbeat                                                                  |
| `PORT`                    | `3000` _(image)_               | Port the dashboard binds                                                                                              |
| `HOSTNAME`                | `127.0.0.1` _(image)_          | Address the dashboard binds. Do not widen under host networking                                                       |

**`DEPLOYHUB_STORAGE_PATH` is the one default the image has to change.** Preflight runs
`df -Pk <path>` and aborts the deployment if the command fails
(`deployment-engine.ts`, `readStorageHeadroom`). The code's default, `/var/lib/docker`, is correct
on a host and does not exist inside the image, so leaving it would refuse every deployment with
`COMMAND_FAILED`. Verified:

```
$ docker exec deployhub df -Pk /var/lib/docker
df: /var/lib/docker: No such file or directory

$ docker exec deployhub df -Pk /var/lib/deployhub | tail -1
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
**2019 and 3000 closed**, Docker from Docker's own apt repository, git, nginx.

1. **Install Caddy** and bootstrap its admin API on `localhost:2019` — see `docs/ops/host-spike.md`.
   Required before any deployment can promote a candidate.
2. **Clone the repository** to `/opt/deployhub` (build location; not the data root).
3. **Create the data root and secrets file** — see [Persistent storage](#persistent-storage).
4. **Write `/etc/deployhub/deployhub.env`**, `chmod 600`, root-owned.
5. **Build the image** — see [Build command](#build-command).
6. **Start the container** — see [Run command](#run-command).
7. **Verify the socket**: `docker exec deployhub docker version --format '{{.Server.Version}}'`.
8. **Verify the dashboard**: `curl -sI http://127.0.0.1:3000/signin` returns 200; `/` returns 307 to
   `/signin`.
9. **Configure nginx** for the dashboard host, obtain a certificate, reload.
10. **Sign in** and register the first project.
11. **Confirm the firewall** still denies 3000 and 2019 from outside.

## Upgrade procedure

The image is disposable; the data root is not. Nothing in these steps touches
`/var/lib/deployhub`.

```bash
cd /opt/deployhub
git fetch --all && git checkout <ref>

# Build first. A failed build must not take the running dashboard down.
docker build --tag deployhub:$(git rev-parse --short HEAD) --tag deployhub:next .

docker stop deployhub && docker rm deployhub
docker tag deployhub:next deployhub:current
docker run --detach --name deployhub … deployhub:current   # the full command above
```

Build before stopping, always: a compile error then costs nothing, and the previous container is
still serving while it happens.

Expect a short outage. DeployHub gives the applications it deploys zero downtime through
candidate-then-promote; it does not currently do that for itself, because that needs a second
instance and a proxy switch, and running two dashboards against one SQLite file is a change to
think about rather than a flag to set. The upgrade is a few seconds and does not interrupt any
running deployment container.

Verify afterwards: the dashboard answers, the deployment history is intact (proof the mount is
attached), and `docker exec deployhub docker version` still reports a server version.

## Rollback procedure

Rolling DeployHub back is retagging, because the sha tags were kept:

```bash
docker stop deployhub && docker rm deployhub
docker tag deployhub:<previous-sha> deployhub:current
docker run --detach --name deployhub … deployhub:current
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
- **Therefore the dashboard must never be publicly reachable without TLS and a real reason.** The
  image binds `127.0.0.1`, ufw denies 3000 inbound, and nginx terminates TLS. All three, not one.
- **`--network host` adds little to this risk.** It removes network isolation from a container that
  already holds root-equivalent access to the host. Ranking it as a serious additional exposure
  would be misreading where the boundary actually is.

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
- **Minimal runtime surface.** No npm, no `next` CLI, no TypeScript, no test runner, no compiler, no
  source tree, no Docker daemon.
- **Secrets never enter argv.** The git credential helper reads the token from the environment,
  because a failed command's argv is written to the deployment log and its environment is not.
- **Keep the Caddy admin API on loopback.** It can repoint production traffic and has no
  authentication.

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

Things this image does not fix, recorded so they are not rediscovered.

**There is still no long-running worker.** This is the blocker for end-to-end operation, and
containerization does not change it. The only `new Worker(...)` in the repository is in
`scripts/deployhub.ts` with `maxDeployments: 1`. The dashboard's Deploy button enqueues a deployment
that nothing picks up. The image runs the web process only. Building the worker entrypoint is
tracked in `docs/internal/DEPLOYHUB_PROJECT_STATE.md`; when it lands it needs a decision about
whether it ships as a second container from this same image (`CMD` override, sharing the data mount
and the socket) or as a child process — the former fits this architecture and needs no supervisor.

**Caddy is still required for deployments.** nginx fronts the dashboard, but the `ReverseProxy`
adapter speaks Caddy's admin API and nothing else. Until Caddy is installed and bootstrapped, a
deployment reaches the promote step and fails there.

**The CLI is not in the runtime image.** `scripts/deployhub.ts` runs from a checkout with
devDependencies; standalone output excludes it. Operate through the dashboard, or run the CLI from
`/opt/deployhub` on a host that has Node — which the target host deliberately does not. If the CLI
is needed on the server, the clean answer is a second `CMD` against this image once the worker
entrypoint exists.
