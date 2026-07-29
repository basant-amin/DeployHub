# Architectural decisions

Each decision records what was chosen, why, and what was rejected. The rejected
alternatives matter as much as the choices — most of them are the obvious first
answer, and knowing why they were passed over is what stops them from being
reintroduced later.

## D1 — Modules live inside the existing layers

**Decision.** Module names (`projects`, `deployments`, `docker`, `git`, `ssh`,
`logs`, `health`) become bounded contexts **inside** `core/` and `server/`, rather
than a new top-level `src/modules/` tree.

**Why.** The committed foundation already establishes a ports-and-adapters layering
with a documented inward dependency rule and per-layer READMEs. Adding
`src/modules/` alongside it creates two competing organizing principles, and the
first question on every new file — "layer or module?" — has two defensible answers.
That ambiguity is how a dependency rule stops being enforceable. Placement inside
the layers keeps the rule mechanical: a module's pure rules go in `core/domain`, its
orchestration in `core/application`, its I/O in `server/adapters`.

The proposed module list is a good decomposition of the _problem_. It is a poor
decomposition of the _codebase_, because it puts `projects` (a domain concept) and
`ssh` (a transport detail) at the same level of significance.

**Rejected.** `src/modules/<name>/{domain,application,infrastructure}` — genuine
NestJS-style vertical modules. Real benefits at scale, but it would mean discarding
committed structure on day one for a one-project, one-server platform, and it makes
the "no I/O in domain logic" rule a per-module convention instead of a directory
invariant.

## D2 — The engine is a declarative step pipeline, not imperative orchestration

**Decision.** Steps are values that declare their timeout, retry eligibility,
idempotency, and compensating action. A runner executes them and owns all failure
handling.

**Why.** The imperative version — one long function of sequential calls wrapped in
nested `try/catch` — puts recovery logic next to each operation, where it is
duplicated, inconsistent, and effectively untestable. There is no single place to
answer "what happens if this fails?", so over time the answer differs per step and
nobody notices. With the properties declared as data, the failure matrix is
readable in one file, and a new step cannot be added without stating how it unwinds.

It also makes compensation ordering automatic rather than remembered: the runner
unwinds completed steps in reverse, so it is impossible to forget to remove a
candidate container in a newly added failure branch.

**Rejected.** A third-party workflow/saga engine (Temporal and similar). Correct
shape, wrong weight — it introduces a server, a client library, and a programming
model to run one pipeline of eleven steps on one host. The `Step` abstraction here
is a few dozen lines and can be replaced by such an engine later without touching
the steps themselves.

## D3 — SSH is a transport, not a capability module

**Decision.** Introduce a `CommandRunner` port meaning "run this process on the
target host." The `git`, `docker`, and `proxy` adapters are built on it and contain
no connection handling. `ssh` and `local` are its two implementations.

**Why.** In the original sketch, `ssh` sits beside `docker` and `git` as a peer,
which implies each of them reaches for it. Then connection setup, timeout handling,
and stream capture get solved three times, slightly differently, and the third one
is the one with the bug. Worse, the tool adapters become untestable without a real
SSH server.

With the transport inverted out: the Docker adapter is a pure function from
intention to command plus interpretation of the result, testable against a fake
runner with no network at all. Development runs against `local/` with no SSH
anywhere. Multi-host later is one `CommandRunner` per host and a host lookup — the
Docker and Git adapters never learn that more than one host exists.

**Rejected.** A Docker adapter that talks to the Docker HTTP API over an SSH
tunnel. More precise than parsing CLI output, and worth revisiting, but it couples
the adapter to Docker's API surface and versioning, and the CLI is the interface an
operator can reproduce by hand when debugging a failed deploy — which is exactly
when reproducibility matters most.

## D4 — Deployments are identified by immutable commit sha and image digest

**Decision.** The target ref is resolved to a commit sha once, at the start, and
every subsequent step uses the sha. Images are tagged by sha and recorded by digest.
The baseline records the previous image's **digest**, not just its tag.

**Why.** A branch is a moving pointer. If a push lands mid-deploy, a design that
carries the branch name forward can build one commit, health-check another, and
report a third — and the resulting incident is nearly impossible to reconstruct.
Digests matter for the same reason on the image side: a tag can be reassigned, so
"roll back to the previous image tag" can silently mean the wrong image, while a
digest cannot.

Recording the digest is also what makes the hardest recovery case survivable: if
the previous container was destroyed, the previous release can still be started
from its digest.

**Rejected.** Deploying branch names directly. Simpler to display, and wrong under
exactly the conditions where correctness matters.

## D5 — Rollback is a deployment, not a separate mechanism

**Decision.** "Roll back to release _R_" creates a new deployment with
`trigger: rollback` and `targetSha: R.commitSha`, run through the same pipeline.
Automatic rollback after a failed promotion is a compensating action inside a
deployment, not a separate flow.

**Why.** A dedicated rollback path is a second, less-exercised copy of the riskiest
code in the platform — and it only runs during incidents, which is the worst
possible time to discover it was never tested. Reusing the pipeline means a rollback
is validated, locked, health-checked, and verified through the public route exactly
like any other deploy. It also gets history and logs for free: a rollback appears in
the timeline as what it is, a deployment of an older commit.

The cost is that a rollback may rebuild when the image has been pruned, making it
slower than a bare `docker start` of the old container. That is bought back by
retaining the previous container stopped rather than removed, which covers the case
that actually matters — rolling back the most recent deploy.

**Rejected.** A fast path that restarts the previous container directly. Faster in
one case, and it skips the health check and route verification that are the reason
to trust the result.

## D6 — Reject concurrent deploys rather than queue them

**Decision.** If a project has an active deployment, a new request is rejected with
`DEPLOYMENT_IN_PROGRESS`. No queue in release 1.

**Why.** A queue raises questions that have no good answer at this scale: does a
third request replace the second, or stack behind it? If two deploys queue for the
same branch, does the first still deploy a commit the operator no longer wants? Does
a queued deploy expire? Rejection has one honest meaning — a deploy is running, try
again after — and the operator retains the decision.

The seam is preserved: admission is a single use case, so adding a queue later
changes one function and no engine code. The lock is keyed by project, so a second
project deploys concurrently from the start.

**Rejected.** A single-slot queue that coalesces requests. Reasonable, and defers
the interesting question (which commit wins) into the platform when it belongs with
the operator.

## D7 — The engine runs in a long-lived worker, not a request handler

**Decision.** The pipeline runs in `server/runtime`'s worker loop. The click handler
only admits and persists the request, then returns a deployment id. Release 1 may
host the worker in the same Node process as the web app; nothing in `core/` depends
on that.

**Why.** A deployment takes minutes and must survive the browser closing. Running
it inside a request handler ties its lifetime to a connection and to whatever
request timeout sits in front of the app, and a proxy timeout at minute two would
abandon a deployment mid-promotion. Separating admission from execution also gives
crash recovery something to work with: the intent is durably recorded before any
work starts.

**Rejected.** Running the pipeline in a server action or route handler. Fewer moving
parts, and it makes the platform's core operation dependent on a browser tab
staying open.

## D8 — Candidate-then-promote, not stop-then-start

**Decision.** Build and start the new container alongside the live one, health-check
it in isolation, then switch traffic at the proxy. Keep the previous container
running through the switch and stop it only during finalization.

**Why.** This single choice converts the most common deployment failures — build
fails, container crashes on boot, app fails its health check — from outages into
non-events. The live container serves every request throughout, and the failure
costs a discarded image. Stop-then-start inverts that: the site is down from the
moment the old container stops until the new one is verified, and if the new one
never becomes healthy, recovery starts from a cold stop under pressure.

It also gives promotion a cheap inverse. Because the previous container is still
running, undoing a promotion is one proxy reload rather than a container start.

**Rejected.** Docker Compose `up -d` with a recreate. Far less code, and it accepts
downtime on every deploy plus a bad-release outage that lasts until someone
notices.

## D9 — Health checks are policy in core, probes are adapters

**Decision.** The adapter performs one probe and reports one result. Thresholds,
intervals, consecutive-pass requirements, and total budget live in
`core/application/policies` and `core/domain/projects`.

**Why.** Health thresholds are the numbers most often tuned in production, and the
ones most worth having tests for. Inside an adapter they end up hidden behind a
network boundary, adjustable only by someone willing to mock HTTP. As a pure
function over attempt history they are trivially testable — including the awkward
cases, like a service that flaps pass/fail/pass and must not be promoted.

**Rejected.** Delegating to Docker's built-in `HEALTHCHECK`. Useful as a secondary
signal and probably worth setting anyway, but it puts the policy in the image, where
DeployHub can neither tune it per environment nor explain a failure — and DeployHub
needs to probe the public route after promotion regardless, which Docker cannot do.

## D10 — Two health checks, before and after promotion

**Decision.** Probe the candidate on its internal port before promotion, and probe
again through the public route after.

**Why.** They prove different things. The first says the application works; the
second says the routing works. A correct container behind a proxy pointing at a
stale port is a complete outage that the first check reports as a success. The
second check is the only thing standing between a proxy config error and a silent
one, and it is cheap.

**Rejected.** Checking only after promotion. One fewer step, and it gives up the
property that makes this design safe — a bad release would already be receiving
traffic before anything noticed.

## D11 — The reconciler exists in release 1

**Decision.** Crash recovery ships with the first release, not after the first
incident.

**Why.** A worker dying mid-deployment is not exotic: a host reboot, an OOM kill, or
a deploy of DeployHub itself will do it. Without a reconciler the visible result is
a deployment stuck in `building` forever, a held lock that blocks every subsequent
deploy, and orphaned containers that someone has to find by hand. Recovery also has
to be designed for, not added: it depends on container and image labels, an
observable proxy upstream, idempotent steps, and baseline digests — all decisions
made elsewhere in this document. Retrofitting it means revisiting all of them.

**Rejected.** Manual recovery via an admin action. Still worth having as an escape
hatch, and inadequate as the primary mechanism, since the platform is unusable
until someone performs it.
