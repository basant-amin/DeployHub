import Link from "next/link";
import { ArrowLeft, Container, Fingerprint, GitCommit, Server } from "lucide-react";

import type { DeploymentDetail } from "@/core/application";
import type { DeploymentState, StepName } from "@/core/domain";
import { Callout, Mono, Panel, SectionLabel } from "@/components/ui/primitives";
import { StatusHeadline } from "@/components/ui/status";
import { BlastRadius } from "@/features/deployments/components/blast-radius";
import { RedeployButton } from "@/features/deployments/components/deploy-button";
import { RelativeTime } from "@/features/deployments/components/relative-time";
import { StepLogs } from "@/features/deployments/components/step-logs";
import { PhaseRail, TrustChecks } from "@/features/deployments/components/step-rail";
import { derivePhases, phaseOfInterest } from "@/features/deployments/phases";
import { loadDeployment, loadProduction } from "@/features/deployments/data";
import { describeTarget, formatDuration, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Which step's log group belongs to which phase.
 *
 * The rail is derived from states and the log is grouped by step, so opening the right group means
 * mapping one to the other. They line up because the engine writes each step's lines while the
 * matching state is current.
 */
const PHASE_TO_STEP: Partial<Record<DeploymentState, StepName>> = {
  validating: "preflight",
  preparing: "capture_baseline",
  fetching: "update_source",
  building: "build",
  starting: "start_candidate",
  health_checking: "health_check",
  promoting: "promote",
  finalizing: "finalize",
};

/**
 * Deployment detail — the single most-shared URL in the product.
 *
 * This is what gets pasted into Slack during an incident, which is why it is a real page rather
 * than a modal: it has to be linkable, refresh-safe, and readable an hour later.
 *
 * Two columns on desktop, stacked below. The rail is the spine; the logs are the body.
 */
export default async function DeploymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const view = await loadDeployment(id);

  if (view.kind === "not-found") {
    return <NotFound />;
  }
  if (view.kind === "error") {
    return (
      <Callout tone="bad">
        <p className="text-ink font-medium">This deployment could not be read.</p>
        <p className="text-ink-3 mt-2 font-mono text-[12.5px]">
          {view.code} — {view.message}
        </p>
      </Callout>
    );
  }

  const { detail } = view;
  // Only for naming what is live in the callout, and for knowing whether a retry can run right now.
  // A failure here must not fail the page.
  const production = await loadProduction(1);
  const project = production.kind === "ready" ? production.history.project : undefined;
  const liveCommitSha = project?.liveCommitSha;

  // The log group to open is chosen from the phase a reader is most likely to want: the running one,
  // then the failing one, then the slowest.
  const interesting = phaseOfInterest(derivePhases(detail));
  const openStep = interesting === undefined ? undefined : PHASE_TO_STEP[interesting.state];
  const target = describeTarget(detail.commitSha, detail.targetRef);

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/deployments"
        className="text-ink-2 hover:text-ink inline-flex w-fit items-center gap-1.5 text-[13px] transition-colors duration-100"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Deployments
      </Link>

      <header className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <StatusHeadline state={detail.state} outcome={detail.outcome} />
            <h1 className="mt-3 flex flex-wrap items-baseline gap-x-3">
              <Mono className="text-ink text-[17px]" title={detail.commitSha}>
                {target.primary}
              </Mono>
              <span className="text-ink-2 text-[13px]">
                {target.qualifier}
                {detail.trigger === "rollback" && (
                  <span className="border-line bg-raised ml-2 rounded-sm border px-1.5 py-0.5 text-[11px]">
                    rollback
                  </span>
                )}
              </span>
            </h1>
            <p className="text-ink-3 mt-1.5 text-[13px]">
              <span data-numeric>{formatDuration(detail.durationMillis)}</span> · by {detail.actor}
              {" · "}
              <RelativeTime
                epochMillis={detail.finishedAt ?? detail.requestedAt}
                initial={formatRelative(detail.finishedAt ?? detail.requestedAt)}
              />
            </p>
          </div>
        </div>

        <TrustChecks detail={detail} />
      </header>

      <BlastRadius
        detail={detail}
        liveCommitSha={liveCommitSha}
        /* The retry belongs *inside* the explanation of what went wrong, not floating in a toolbar
           above it — the action and its reason should be read in one movement. */
        actions={
          detail.isActive ? undefined : (
            <RedeployButton
              targetRef={detail.targetRef}
              blocked={project?.activeDeploymentId !== undefined}
            />
          )
        }
      />

      {detail.warnings.length > 0 && (
        <Callout tone="warn">
          <p className="text-ink font-medium">
            {detail.warnings.length === 1
              ? "One thing did not go to plan"
              : `${detail.warnings.length} things did not go to plan`}
          </p>
          <p className="text-ink-2 mt-1">
            The release is live and verified — these did not affect it.
          </p>
          <ul className="mt-2.5 flex flex-col gap-1.5">
            {detail.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`} className="text-ink-2">
                <Mono className="text-ink-3">{warning.code}</Mono> {warning.message}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <div className="flex flex-col gap-3">
          <SectionLabel>Steps</SectionLabel>
          <Panel className="overflow-hidden py-1.5">
            <PhaseRail detail={detail} />
          </Panel>
          <TechnicalDetails detail={detail} />
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <SectionLabel>Log</SectionLabel>
          <Panel className="overflow-hidden">
            <StepLogs logs={detail.logs} openStep={openStep} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

/**
 * The exact machine values, behind a disclosure.
 *
 * Wanted occasionally and in place, which is why this is an inline `<details>` rather than a
 * separate screen or a permanently-expanded block of hex.
 */
function TechnicalDetails({ detail }: { detail: DeploymentDetail }) {
  return (
    <details className="group border-line bg-surface rounded-lg border">
      <summary className="text-ink-2 hover:text-ink flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-[13px] transition-colors duration-100">
        <span className="text-ink-3 transition-transform duration-150 group-open:rotate-90">›</span>
        Technical details
      </summary>
      <dl className="border-line flex flex-col gap-3 border-t px-4 py-3.5 text-[12.5px]">
        <Fact icon={<GitCommit className="size-3.5" />} label="Commit">
          {detail.commitSha ?? "—"}
        </Fact>
        <Fact icon={<Container className="size-3.5" />} label="Image">
          {detail.imageReference ?? "—"}
        </Fact>
        <Fact icon={<Fingerprint className="size-3.5" />} label="Digest">
          {detail.imageDigest ?? "—"}
        </Fact>
        <Fact icon={<Server className="size-3.5" />} label="Deployment">
          {detail.id}
        </Fact>
      </dl>
    </details>
  );
}

function Fact({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-ink-3 flex items-center gap-1.5">
        <span aria-hidden className="text-ink-3">
          {icon}
        </span>
        {label}
      </dt>
      <dd>
        <Mono className="text-ink-2 block text-[12px] break-all">{children}</Mono>
      </dd>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/deployments"
        className="text-ink-2 hover:text-ink inline-flex w-fit items-center gap-1.5 text-[13px]"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Deployments
      </Link>
      <Callout tone="neutral">
        <p className="text-ink font-medium">No such deployment</p>
        <p className="mt-1">
          The id in this link does not match anything DeployHub has a record of.
        </p>
      </Callout>
    </div>
  );
}
