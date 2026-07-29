"use client";

/**
 * Deploy.
 *
 * The only unconfirmed mutation in the product, and deliberately so: deploying is the thing this
 * tool is for, it is reversible in one click, and a confirmation dialog in front of the primary
 * action trains people to dismiss dialogs — which is exactly the habit you do not want them to have
 * when the rollback dialog appears.
 *
 * Three states, one geometry. Idle, submitting, and already-deploying all occupy the same box, so
 * nothing in the hero moves when one replaces another.
 */

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { deploy } from "@/app/actions";
import { Button, buttonStyles } from "@/components/ui/primitives";
import { IDLE } from "@/lib/action-state";
import { formatRef } from "@/lib/format";

export function DeployButton({
  targetRef,
  activeDeploymentId,
  disabledReason,
}: {
  targetRef: string;
  /** Set while something is already in flight. Invariant 1: one at a time, per project. */
  activeDeploymentId: string | undefined;
  /** Why the project cannot be deployed at all — a disabled project, for instance. */
  disabledReason?: string | undefined;
}) {
  const [state, action] = useActionState(deploy, IDLE);

  if (activeDeploymentId !== undefined) {
    // Not a disabled Deploy button: a link to the thing that is blocking it. The reason a control is
    // unavailable should be one click away, not a mystery.
    return (
      <Link
        href={`/deployments/${activeDeploymentId}`}
        className={buttonStyles({ variant: "secondary", size: "lg", className: "min-w-[132px]" })}
      >
        View in progress
      </Link>
    );
  }

  if (disabledReason !== undefined) {
    return (
      <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
        <Button variant="primary" size="lg" disabled className="min-w-[132px]">
          Deploy
        </Button>
        <p className="text-ink-3 max-w-[220px] text-[12px] sm:text-right">{disabledReason}</p>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col items-stretch gap-1.5 sm:items-end">
      <Submit targetRef={targetRef} />
      {!state.ok && (
        <p className="text-bad max-w-[240px] text-[12px] sm:text-right" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

/**
 * Try the same thing again — the action offered inside a failure callout.
 *
 * Explicitly the *same ref*, not the project's configured one. After a failed rollback to a sha,
 * "Deploy" would silently mean something else, and a retry button that quietly retries a different
 * thing is worse than no retry button.
 */
export function RedeployButton({
  targetRef,
  blocked,
}: {
  targetRef: string;
  /** True while another deployment holds the project. The engine would refuse anyway. */
  blocked: boolean;
}) {
  const [state, action] = useActionState(deploy, IDLE);

  return (
    <form action={action} className="mt-3.5 flex flex-wrap items-center gap-3">
      <input type="hidden" name="ref" value={targetRef} />
      <Retry label={`Deploy ${formatRef(targetRef)} again`} blocked={blocked} />
      {blocked && (
        <span className="text-ink-3 text-[12px]">another deployment is already running</span>
      )}
      {!state.ok && (
        <span className="text-bad text-[12px]" role="alert">
          {state.message}
        </span>
      )}
    </form>
  );
}

function Retry({ label, blocked }: { label: string; blocked: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" size="sm" disabled={pending || blocked}>
      {pending ? "Queued…" : label}
    </Button>
  );
}

/**
 * The optimistic state.
 *
 * `useFormStatus` is the whole mechanism: it is true from the click until the server action's
 * redirect lands, which is precisely the window where a person needs to know the click registered.
 * No local state, so there is nothing to get stuck.
 */
function Submit({ targetRef }: { targetRef: string }) {
  const { pending } = useFormStatus();
  return (
    <>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        disabled={pending}
        className="min-w-[132px]"
        aria-label={`Deploy ${targetRef}`}
      >
        {pending ? "Queued…" : "Deploy"}
      </Button>
      <p className="text-ink-3 text-[12px] sm:text-right">
        {pending ? "starting…" : formatRef(targetRef)}
      </p>
    </>
  );
}
