/**
 * The hero on `/`. The most important 200px in the product.
 *
 * It answers one question — *is production okay?* — before it says anything about the platform.
 * Two shapes, chosen by whether a deployment is in flight, rendered into the same geometry so
 * nothing moves when one replaces the other.
 *
 * While a deployment is running it shows the sentence no other tool in this category shows:
 * **the previous release is still live and serving traffic.** That is true for every state up to
 * promotion, and it is the single most reassuring fact available to a reader watching a build.
 */

import { ArrowUpRight, RotateCcw } from "lucide-react";

import { Link } from "@/components/ui/link";
import type { DeploymentSummary, ProjectOverview } from "@/core/application";
import { Mono, Panel } from "@/components/ui/primitives";
import { StatusDot, statusMeta } from "@/components/ui/status";
import { describeTarget, formatRef, formatRelative, shortSha } from "@/lib/format";

import { RelativeTime } from "@/features/deployments/components/relative-time";

export function ProductionHero({
  project,
  active,
  deployAction,
  rollbackAction,
}: {
  project: ProjectOverview;
  /** The in-flight deployment, when there is one. */
  active: DeploymentSummary | undefined;
  /** The Deploy control. Passed in so this stays a Server Component. */
  deployAction: React.ReactNode;
  /** The rollback control, rendered inside the hint strip beside the destination it names. */
  rollbackAction: React.ReactNode;
}) {
  return (
    <Panel className="px-6 py-6 sm:px-8 sm:py-7">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {active === undefined ? (
            <LiveHeadline project={project} />
          ) : (
            <ActiveHeadline active={active} />
          )}
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
          {deployAction}
        </div>
      </div>

      <Facts project={project} />

      {active === undefined ? (
        <RollbackHint project={project} action={rollbackAction} />
      ) : (
        <StillLive project={project} activeId={active.id} />
      )}
    </Panel>
  );
}

/* -- Idle: what is live ------------------------------------------------- */

function LiveHeadline({ project }: { project: ProjectOverview }) {
  const hasRelease = project.liveCommitSha !== undefined;

  return (
    <>
      <span className="flex items-center gap-2.5">
        <StatusDot
          meta={
            hasRelease
              ? { tone: "ok", label: "Live", glyph: "●", live: false }
              : { tone: "idle", label: "Not deployed", glyph: "○", live: false }
          }
          className="size-2.5"
        />
        <span
          className={`text-[15px] font-semibold tracking-tight ${hasRelease ? "text-ok" : "text-ink-2"}`}
        >
          {hasRelease ? "Live" : "Not deployed yet"}
        </span>
      </span>

      {hasRelease ? (
        <>
          <p className="mt-3 flex flex-wrap items-baseline gap-x-2.5">
            <Mono className="text-ink text-[15px]">{shortSha(project.liveCommitSha)}</Mono>
            <span className="text-ink-2 text-[13px]">on {formatRef(project.targetRef)}</span>
          </p>
          {project.liveSince !== undefined && (
            <p className="text-ink-3 mt-1 text-[13px]">
              deployed{" "}
              <RelativeTime
                epochMillis={project.liveSince}
                initial={formatRelative(project.liveSince)}
              />
            </p>
          )}
        </>
      ) : (
        <p className="text-ink-2 mt-3 max-w-md text-[13px]">
          Deploy {project.targetRef} to put this project into production for the first time.
        </p>
      )}
    </>
  );
}

/* -- Active: what is happening ----------------------------------------- */

function ActiveHeadline({ active }: { active: DeploymentSummary }) {
  const meta = statusMeta(active.state, active.outcome);
  const target = describeTarget(active.commitSha, active.targetRef);
  return (
    <>
      <span className="flex items-center gap-2.5">
        <StatusDot meta={meta} className="size-2.5" />
        <span className="text-run text-[15px] font-semibold tracking-tight">
          Deploying · {meta.label.toLowerCase()}
        </span>
      </span>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-2.5">
        <Mono className="text-ink text-[15px]" title={active.commitSha}>
          {target.primary}
        </Mono>
        {target.qualifier !== undefined && (
          <span className="text-ink-2 text-[13px]">{target.qualifier}</span>
        )}
      </p>
      <p className="text-ink-3 mt-1 text-[13px]">
        started{" "}
        <RelativeTime
          epochMillis={active.requestedAt}
          initial={formatRelative(active.requestedAt)}
        />{" "}
        by {active.actor}
      </p>
    </>
  );
}

/* -- The three facts worth permanent space ----------------------------- */

function Facts({ project }: { project: ProjectOverview }) {
  return (
    <dl className="border-line mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 border-t pt-5 text-[13px]">
      <div className="flex items-center gap-2">
        <dt className="sr-only">Route</dt>
        <dd>
          <a
            href={`https://${project.route}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink hover:text-accent inline-flex items-center gap-1.5 font-mono transition-colors duration-100"
          >
            {project.route}
            <ArrowUpRight className="text-ink-3 size-3.5" aria-hidden />
          </a>
        </dd>
      </div>

      <div className="flex items-center gap-2">
        <dt className="text-ink-3">Health</dt>
        <dd>
          <Mono className="text-ink-2">GET {project.healthCheckPath}</Mono>
        </dd>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <dt className="text-ink-3">Repository</dt>
        <dd className="min-w-0">
          <Mono className="text-ink-2 block truncate">{project.repositoryUrl}</Mono>
        </dd>
      </div>
    </dl>
  );
}

/* -- The escape hatch, always visible ---------------------------------- */

/**
 * A quiet bordered strip, not a red button.
 *
 * Naming the destination is the point: under stress, "returns to a3f9c21" is information and
 * "Rollback" is a question. It is present rather than shouting because most of the time it is
 * reassurance rather than an instruction.
 */
function RollbackHint({ project, action }: { project: ProjectOverview; action: React.ReactNode }) {
  if (project.rollbackTarget === undefined) {
    return null;
  }
  const target = project.rollbackTarget;
  return (
    <div className="border-line bg-canvas text-ink-2 mt-5 flex flex-wrap items-center justify-between gap-x-2 gap-y-2 rounded-md border px-3.5 py-2.5 text-[13px]">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <RotateCcw className="text-ink-3 size-3.5" aria-hidden />
        <span>Rollback available — one click returns to</span>
        <Mono className="text-ink">{shortSha(target.commitSha)}</Mono>
        <span className="text-ink-3">
          (
          <RelativeTime
            epochMillis={target.deployedAt}
            initial={formatRelative(target.deployedAt)}
          />
          )
        </span>
      </span>
      {action}
    </div>
  );
}

/** The reassurance line. True until promotion, and the domain knows exactly when it stops being. */
function StillLive({ project, activeId }: { project: ProjectOverview; activeId: string }) {
  return (
    <div className="border-line bg-canvas mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border px-3.5 py-2.5 text-[13px]">
      <span className="text-ink-2">
        {project.liveCommitSha === undefined ? (
          "Nothing is serving traffic yet."
        ) : (
          <>
            <Mono className="text-ink">{shortSha(project.liveCommitSha)}</Mono> is still live and
            serving traffic.
          </>
        )}
      </span>
      <Link
        href={`/deployments/${activeId}`}
        className="text-ink-2 decoration-line hover:text-ink underline underline-offset-4 transition-colors duration-100"
      >
        View deployment →
      </Link>
    </div>
  );
}
