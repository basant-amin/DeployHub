# MVP dashboard — UI architecture

The structure to build against, not the build itself. Three screens, dark-first, no
sidebar. It should feel like Railway or Vercel: mostly whitespace, one obvious action, and
status you can read at a glance from across the room.

## Routes

Four routes. There is one project in the MVP, so the home screen _is_ the project.

| Route               | Screen                                       | Data                                  |
| ------------------- | -------------------------------------------- | ------------------------------------- |
| `/`                 | Project overview + deployment history        | `GetDeploymentHistory`                |
| `/deployments/[id]` | Deployment detail: timeline, steps, live log | `GetDeploymentDetail`                 |
| `/setup`            | Register the project / edit its config       | `ProjectRepository` via a form action |
| `/login`            | Single shared password                       | middleware                            |

No `/projects` list, no settings tree, no nested navigation. When a second project exists,
`/` becomes a list and today's `/` becomes `/projects/[slug]` — a rename, not a redesign.

## Component structure

```
app/
  layout.tsx                    shell: <Header/>, theme, fonts, one <main> container
  page.tsx                      server component — calls GetDeploymentHistory
  deployments/[id]/page.tsx     server component — calls GetDeploymentDetail
  setup/page.tsx                project form
  login/page.tsx
  actions.ts                    server actions: deploy, rollback, saveProject

features/
  deployments/
    components/
      DeployButton.tsx          client — disabled while activeDeploymentId is set
      RollbackButton.tsx        client — confirm dialog, release picker
      DeploymentList.tsx        server — rows, no client JS
      DeploymentRow.tsx         server — status dot, ref, actor, duration, relative time
      DeploymentTimeline.tsx    server — vertical rail of TimelineEntry
      StepList.tsx              server — StepView, duration per step
      LogViewer.tsx             client — polls, virtualized, auto-scroll with pause
      StatusBadge.tsx           server — one component owns status → colour
      useDeploymentPoll.ts      client hook — polls detail while isActive
  projects/
    components/
      ProjectCard.tsx           server — live commit, route, health path, Deploy
      ProjectForm.tsx           client — renders DeployConfig issue lists as field errors

components/ui/                  shadcn primitives (button, badge, dialog, input, card)
```

**Server components by default.** Only four things are client components: the two action
buttons, the log viewer, and the project form. Everything else renders on the server from a
read model, which is why the read models are plain serializable data.

**One component owns status colour.** `StatusBadge` maps `DeploymentState` → colour and
label. Nothing else may hard-code a status colour, or the list and the detail page will
drift.

## Live updates: polling, not streaming

`useDeploymentPoll` calls the detail action every **1.5 s** while `detail.isActive`, then
stops. No SSE, no WebSockets, no event bus. At one deployment at a time and a log measured
in hundreds of lines this is indistinguishable from streaming, and it is perhaps 200 lines
less infrastructure. The `DeploymentLogSink.tail` port already exists for when that stops
being true.

The polling loop needs no separate status check because `isActive` is on the payload it is
already fetching.

## Design system

**Dark first.** Build the dark palette, then derive light. Not the other way round — a light
theme dimmed always looks like a light theme dimmed.

```
Background      #0A0A0B   page
Surface         #131316   cards, rows
Surface raised  #1A1A1F   hover, popovers
Border          #26262B   1px hairlines, never shadows for separation
Text primary    #EDEDEF
Text secondary  #8B8B93   metadata, timestamps
Text tertiary   #5B5B63   labels
Accent          #6E56CF   the Deploy button, focus rings
```

**Status colours** — the only place colour carries meaning, so nothing else competes with
them:

| State                               | Colour                            | Reads as             |
| ----------------------------------- | --------------------------------- | -------------------- |
| `succeeded`                         | `#30A46C` green                   | shipped              |
| active (`building`, `promoting`, …) | `#0091FF` blue, pulsing dot       | working              |
| `queued`                            | `#8B8B93` grey                    | waiting              |
| `failed`                            | `#E5484D` red                     | did not ship         |
| `rolled_back`                       | `#F5A524` amber                   | undone, site is fine |
| `rollback_failed`                   | `#E5484D` red on a red-tinted row | **needs a human**    |
| `canceled`                          | `#5B5B63` dim                     | stopped              |

Amber for `rolled_back` matters: it is not a failure of the platform and must not read like
one, but it did not ship either. `rollback_failed` is the one state allowed to shout.

**Typography.** Geist or Inter for UI; a monospace (Geist Mono / JetBrains Mono) for commit
shas, log lines, container names, and durations. Two sizes carry most of the interface: 14px
body, 13px metadata. Headings are 20px semibold, not 32px — this is a control panel, not a
landing page.

**Spacing.** An 8px scale, used generously: 24px card padding, 16px between rows, 32px
between sections, a 1120px max content width centred. Whitespace is the main visual device;
borders are hairlines and there are no drop shadows except on popovers.

**Motion.** Almost none. A 150ms fade on state changes, a slow pulse on the active status
dot, and nothing else. No skeletons that shift layout — reserve the row height instead.

## Screen one — `/` overview and history

```
┌────────────────────────────────────────────────────────────────┐
│  DeployHub                                        basant ▾     │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   One Community                          ● Live                │
│   app.onecommunity.example                                     │
│                                                                │
│   a3f9c21  ·  deployed 2 hours ago  ·  main                    │
│                                          ┌──────────────────┐  │
│   /healthz · 200                         │     Deploy       │  │
│                                          └──────────────────┘  │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│   Deployments                                                  │
│                                                                │
│   ● succeeded   a3f9c21  main      basant    1m 42s   2h ago  ›│
│   ◐ building    7b2e004  main      basant    running…        ›│
│   ▲ rolled back 91ca77f  main      basant    2m 08s   1d ago  ›│
│   ● failed      44de1a2  main      basant      38s    2d ago  ›│
└────────────────────────────────────────────────────────────────┘
```

The Deploy button is the only accent-coloured element on the page. It disables itself when
`activeDeploymentId` is set and says why on hover — never offering an action the platform
will refuse. Each row links to the detail screen; the whole row is the target, not a chevron.

## Screen two — `/deployments/[id]` detail

Two columns on desktop, stacked on mobile. The timeline is the spine.

```
┌────────────────────────────────────────────────────────────────┐
│  ‹ Deployments                                                 │
│                                                                │
│  ● Succeeded    7b2e004   main   ·   1m 42s   ·   by basant    │
│  deployhub/one-community@sha256:4f1a…       ┌───────────────┐  │
│                                             │   Rollback    │  │
│                                             └───────────────┘  │
├──────────────────────┬─────────────────────────────────────────┤
│  ✓ validating    0.2s│  ┌───────────────────────────────────┐  │
│  ✓ preparing     0.1s│  │ 12:04:01  preflight passed        │  │
│  ✓ fetching      1.8s│  │ 12:04:02  checking out main       │  │
│  ✓ building     48.0s│  │ 12:04:04  building 7b2e004…       │  │
│  ✓ starting      2.1s│  │ 12:04:52  Step 4/9 : COPY . .     │  │
│  ✓ health check  6.0s│  │ 12:04:58  starting one-community… │  │
│  ✓ promoting     0.4s│  │ 12:05:04  probing /healthz        │  │
│  ✓ finalizing    3.2s│  │ 12:05:10  pointing route at…      │  │
│                      │  └───────────────────────────────────┘  │
│                      │  ⏸ pause  ⤓ download                    │
└──────────────────────┴─────────────────────────────────────────┘
```

**The failure case is the one to design carefully.** When a deployment fails, the detail
screen leads with the error code and message in a bordered callout above the timeline, the
failing step is marked red in the rail, and the log auto-scrolls to the first `stderr` line
rather than to the bottom. A rolled-back deployment additionally states plainly: _"Traffic
was returned to a3f9c21. The site was not affected."_ — because that is the first question
anyone asks.

**Rollback** appears on any succeeded deployment that is not the live one. It opens a confirm
dialog naming the commit being returned to, and it calls `RequestRollback`, which queues an
ordinary deployment — so the user lands on a _new_ detail page and watches it run. That is
the honest representation of what rollback is.

## Screen three — `/setup`

One form, one column, 640px wide. Fields map directly onto `DeployConfig`: repository URL,
credential reference, branch, Dockerfile path, build context, container port, public route,
health path, expected status, image retention.

`DeployConfig.create` already returns every invalid field at once as an issue list, so the
form maps issues onto fields in one pass rather than validating twice. No client-side
validation library — the domain is the validator.

## Access control

The MVP is a web page that can deploy code. Before it is reachable, one of:

1. **Bind to localhost or a VPN address** (Tailscale), or
2. **A single shared password** in middleware, session cookie, no user records.

That is the whole of auth for the MVP. No RBAC, no accounts, no invitations. It ships in the
same phase as the UI, not after it.

## What is deliberately not here

No sidebar. No settings tree. No metrics charts, no analytics, no cost view. No notification
centre. No command palette. No onboarding tour. No environments (staging/production) — one
project, one server, one route.

Each of those is a phase after MVP, and every one of them would push the first real
deployment further away.
