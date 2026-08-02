# syntax=docker/dockerfile:1
#
# DeployHub's own runtime image.
#
# DeployHub deploys applications with Docker, and it is itself deployed with Docker. The host
# is expected to provide Docker, git, nginx, SSH, and a firewall — and nothing else. No Node,
# no npm, no process manager. Every application on the box, this one included, brings its own
# runtime in its image.
#
# Four stages. `deps` and `builder` carry the full toolchain and are discarded; `runner` is the
# only stage that ships, and it contains a traced Node server, git, and the Docker CLI. There
# is no daemon inside the container: the CLI talks to the host's daemon over a bind-mounted
# socket, which is what lets a containerized DeployHub keep controlling host Docker.
#
# The full operational contract — bind mounts, network mode, and the security implications of
# handing this container the Docker socket — is in `docs/docker.md`. The run command there is
# part of the architecture, not a convenience: this image will not work correctly under default
# bridge networking, for reasons that file explains.

# Concrete versions, never `latest`. Bumping either is a deliberate, reviewable edit.
#
# NODE_VERSION tracks `.nvmrc` (24) and `engines.node` (>=24.0.0). Node 24 is required rather
# than merely supported: persistence uses `node:sqlite`, the built-in driver, which is why this
# project has no native module to compile and no build toolchain in the final image.
#
# DOCKER_CLI_VERSION is the client, not the daemon. 29.1.x is the line the adapters in
# `src/server/adapters/docker` were verified against (see `docs/ops/host-spike.md`). A client
# older than the host daemon is fine — the CLI negotiates the API version down — so this does
# not need to move every time the host is upgraded.
ARG NODE_VERSION=24.18.1
ARG DOCKER_CLI_VERSION=29.1.5

# ---------------------------------------------------------------------------
# Docker client — copied from the official image rather than curled from a release URL,
# so the binaries are pinned by tag and fetched through the same registry as everything else.
# ---------------------------------------------------------------------------
FROM docker:${DOCKER_CLI_VERSION}-cli AS docker-cli

# ---------------------------------------------------------------------------
# deps — dependencies only, in their own stage so the layer caches on the lockfile
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /build

# Only the manifests, so editing application code does not invalidate the install layer.
COPY package.json package-lock.json ./

# `npm ci` for the lockfile-exact install a build must have.
#
# `--ignore-scripts` because no production dependency needs a lifecycle script here: the one
# script in `package.json` is `prepare: husky`, which is a developer git-hook installer with no
# `.git` to install into. Skipping arbitrary install-time code in an image build is also simply
# the safer default. Verified: `next build` succeeds with scripts disabled.
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------
# builder — compile the application
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /build

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /build/node_modules ./node_modules
COPY . .

# Produces `.next/standalone` (see `output: "standalone"` in `next.config.ts`): a traced
# module graph plus a `server.js`, which is what the runtime stage runs. Type errors fail the
# build here, because `typescript.ignoreBuildErrors` is false.
#
# No build secrets and no build args: nothing in this application is baked in at build time.
# `NEXT_PUBLIC_*` would be, but the app defines none that it reads, so the image is
# environment-independent — the same artifact runs in staging and in production.
RUN npm run build

# ---------------------------------------------------------------------------
# runner — the only stage that ships
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner

# git: the deployment engine clones and checks out project sources into the workspace
#      (`src/server/adapters/git/git-client.ts`). Its credential helper is an inline shell
#      function, so a POSIX shell is required too — the base image provides it.
# ca-certificates: HTTPS to GitHub, and the post-promotion probe of the public route.
RUN apt-get update \
 && apt-get install --no-install-recommends --yes git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The Docker client. No daemon, no containerd, no runc — this image cannot run containers, it
# can only ask the host's daemon to.
#
# buildx is not optional. `docker build` has routed through BuildKit via this CLI plugin since
# Docker 23, and without the plugin the adapter's build step fails with "the buildx component
# is missing" rather than falling back. `docker-compose` is deliberately not copied: DeployHub
# drives container lifecycle directly, and the plugin would be 30 MB of unreachable code.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx \
                       /usr/local/lib/docker/cli-plugins/docker-buildx

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# Next's standalone server binds `HOSTNAME`, and Docker sets that variable to the container id,
# which is not a bindable address — so it has to be set explicitly. Loopback is the correct
# value under the documented `--network host` model: the dashboard is reached through nginx on
# the host, and binding it anywhere else would publish a deploy button on a public interface.
# Override with `-e HOSTNAME=0.0.0.0` only under bridge networking with `-p`, which is a
# development arrangement — see `docs/docker.md`.
ENV HOSTNAME=127.0.0.1

# Set explicitly because Docker does not derive HOME from /etc/passwd for `USER`. buildx keeps
# client state under it, and an unwritable HOME breaks `docker build`.
ENV HOME=/home/node \
    DOCKER_CONFIG=/home/node/.docker

# The persistent root: SQLite database, project workspaces, secrets file. Every path in
# `runtimeConfigFromEnv()` derives from it. This must be a bind mount at run time — unmounted,
# the deployment history lives in the container's writable layer and dies with the container.
ENV DEPLOYHUB_ROOT=/var/lib/deployhub

# Preflight measures free disk with `df -Pk` on this path and aborts the deployment if the
# command fails. The code's default is `/var/lib/docker`, which is the right answer on a host
# and does not exist inside this image — leaving it would refuse every deployment with
# `COMMAND_FAILED`. The bind-mounted data root is the honest substitute: it is a real host
# filesystem, and on a single-volume server it is the same one Docker's data root sits on.
# Override only if `/var/lib/docker` is a separate volume, and bind-mount it read-only if so.
ENV DEPLOYHUB_STORAGE_PATH=/var/lib/deployhub

WORKDIR /app

# `node` is uid/gid 1000, provided by the base image. Its home already exists and is owned by
# it, which is what makes buildx's state directory writable.
#
# Running as a non-root user does not make holding the Docker socket safe — `docs/docker.md`
# is explicit that socket access is root-equivalent on the host regardless of uid. What it does
# buy is real but narrower: files this process writes into the bind mounts are owned by a known
# unprivileged uid rather than by root, and a defect that is not a Docker call cannot write
# outside them.
RUN mkdir -p /var/lib/deployhub /home/node/.docker \
 && chown node:node /var/lib/deployhub /home/node/.docker

# The standalone output already contains the traced `node_modules` and `server.js`; static
# assets are emitted outside it and have to be placed by hand. There is no `public/` directory
# in this project, so none is copied.
COPY --from=builder --chown=node:node /build/.next/standalone ./
COPY --from=builder --chown=node:node /build/.next/static ./.next/static

USER node

# Metadata only, and ignored entirely under `--network host` — the server binds PORT on the
# host directly. Declared because it is the port the application listens on and tooling reads it.
EXPOSE 3000

# No HEALTHCHECK. The instruction to add one only if a real health endpoint already exists is
# the right one, and this application has none: every route is a dashboard page behind the
# session gate, and `/signin` proves that Next is serving without touching SQLite or Docker —
# which is precisely the part worth knowing about. A probe that reports green while the
# database is unreachable is worse than no probe. `docs/docker.md` records what a truthful
# health endpoint would have to check.

CMD ["node", "server.js"]
