/**
 * The blast-radius callout — the first thing a reader sees on a deployment that did not simply
 * succeed, and the design decision that most distinguishes this product.
 *
 * Every other tool in this category renders four very different outcomes identically: a red
 * "deployment failed". DeployHub knows the difference, so the callout leads with **impact**, then
 * **cause**, then **action** — in that order, always. The exit code is third because it is the
 * least urgent of the three.
 *
 * Impact is derived, not stored: a deployment that never reached `promoting` never moved traffic,
 * which the timeline proves.
 */

import type { DeploymentDetail } from "@/core/application";
import { Callout, Mono } from "@/components/ui/primitives";
import { formatDuration, humanizeCode, shortSha } from "@/lib/format";

export function BlastRadius({
  detail,
  liveCommitSha,
  actions,
}: {
  detail: DeploymentDetail;
  /** What is serving traffic now, so the callout can name it. */
  liveCommitSha: string | undefined;
  actions?: React.ReactNode;
}) {
  const promoted = detail.timeline.some((entry) => entry.state === "promoting");

  if (detail.state === "rollback_failed") {
    return (
      <Callout tone="alarm">
        <Headline>DeployHub could not restore the previous release</Headline>
        <p className="text-ink mt-1.5">
          Production may be serving a broken version, and deployments are paused until this is
          resolved. This is the one state the platform cannot recover from on its own.
        </p>
        <Cause detail={detail} />
        <Next>
          Check what the route is serving, then run <Mono className="text-ink">deployhub show</Mono>{" "}
          to see the recorded state.
        </Next>
        {actions}
      </Callout>
    );
  }

  if (detail.state === "rolled_back") {
    const window = detail.routeVerifiedAt === undefined ? undefined : detail.durationMillis;
    return (
      <Callout tone="warn">
        <Headline>Rolled back automatically</Headline>
        <p className="text-ink mt-1.5">
          Traffic was returned to{" "}
          <Mono className="text-ink">{shortSha(liveCommitSha) || "the previous release"}</Mono>.
          Production was briefly affected while the switch was verified
          {window === undefined ? "" : ` (about ${formatDuration(window)})`}.
        </p>
        <Cause detail={detail} />
        {actions}
      </Callout>
    );
  }

  if (detail.state === "failed") {
    return (
      <Callout tone="bad">
        {/* The sentence people actually need, and almost nobody prints. */}
        <Headline>
          {promoted
            ? "This deployment did not ship"
            : `Production was not affected — ${shortSha(liveCommitSha)} stayed live throughout`}
        </Headline>
        <Cause detail={detail} />
        {actions}
      </Callout>
    );
  }

  if (detail.state === "interrupted") {
    return (
      <Callout tone="warn">
        <Headline>DeployHub lost track of this deployment</Headline>
        <p className="text-ink mt-1.5">
          The worker running it stopped before it finished. The route is unchanged; the next
          deployment will re-read the live state from the server.
        </p>
        {actions}
      </Callout>
    );
  }

  if (detail.state === "canceled") {
    return (
      <Callout tone="neutral">
        <Headline>Canceled before it shipped</Headline>
        <p className="text-ink-2 mt-1.5">
          Production was not affected — {shortSha(liveCommitSha)} stayed live throughout.
        </p>
        {actions}
      </Callout>
    );
  }

  if (detail.state === "succeeded" && detail.outcome === "no_change") {
    return (
      <Callout tone="neutral">
        <Headline>Nothing to deploy</Headline>
        <p className="text-ink-2 mt-1.5">
          <Mono className="text-ink">{shortSha(detail.commitSha)}</Mono> was already live, so no
          image was built and no traffic moved.
        </p>
      </Callout>
    );
  }

  return null;
}

function Headline({ children }: { children: React.ReactNode }) {
  return <p className="text-ink text-sm font-medium">{children}</p>;
}

/** The error itself: a readable phrase, the stable code beside it, and the step it happened in. */
function Cause({ detail }: { detail: DeploymentDetail }) {
  if (detail.errorCode === undefined) {
    return null;
  }
  const failedStep = detail.steps.find((step) => step.status === "failed");
  return (
    <div className="border-line/60 mt-3 border-t pt-3">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-ink font-medium">{humanizeCode(detail.errorCode)}</span>
        {failedStep !== undefined && (
          <span className="text-ink-2">
            in <Mono className="text-ink-2">{failedStep.name.replaceAll("_", " ")}</Mono>
          </span>
        )}
        <Mono className="text-ink-3">{detail.errorCode}</Mono>
      </p>
      {detail.errorMessage !== undefined && (
        <p className="text-ink-2 mt-1.5">{detail.errorMessage}</p>
      )}
    </div>
  );
}

function Next({ children }: { children: React.ReactNode }) {
  return <p className="text-ink-2 mt-3">{children}</p>;
}
