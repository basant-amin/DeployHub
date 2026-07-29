"use client";

/**
 * Roll back.
 *
 * This one *is* confirmed, and the confirmation earns its place by carrying information the button
 * cannot: which commit production returns to, when that commit was deployed, and what leaves. A
 * dialog that only says "Are you sure?" is a speed bump. This one is a fact sheet.
 *
 * Native `<dialog>` rather than a library: focus trapping, `Esc` to close, inertness of the page
 * behind it, and the top-layer stacking are all built in and better tested than anything shipped in
 * a bundle. Tailwind's preflight zeroes the margin the UA uses to centre it, hence the explicit
 * `m-auto`.
 */

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { RotateCcw } from "lucide-react";

import { rollback } from "@/app/actions";
import type { RollbackTarget } from "@/core/application";
import { Button, Mono } from "@/components/ui/primitives";
import { IDLE } from "@/lib/action-state";
import { formatAbsolute, shortSha } from "@/lib/format";

export function RollbackButton({
  target,
  liveCommitSha,
  route,
}: {
  target: RollbackTarget;
  /** What is serving traffic now — the thing that goes away. */
  liveCommitSha: string | undefined;
  route: string;
}) {
  const [state, action] = useActionState(rollback, IDLE);
  const dialog = useRef<HTMLDialogElement>(null);

  // A failure comes back as state, not as a navigation, so the dialog has to stay open to show it.
  // Success never reaches here: the action redirects.
  useEffect(() => {
    if (!state.ok) {
      dialog.current?.showModal();
    }
  }, [state.ok]);

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="text-ink-2 decoration-line hover:text-ink inline-flex shrink-0 items-center gap-1.5 text-[13px] underline underline-offset-4 transition-colors duration-100"
      >
        <RotateCcw className="size-3.5" aria-hidden />
        Roll back
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="rollback-title"
        className="border-line bg-surface text-ink shadow-modal m-auto w-[min(30rem,calc(100vw-2rem))] rounded-xl border p-0 backdrop:bg-black/60"
      >
        <form action={action} className="flex flex-col gap-4 p-5">
          <input type="hidden" name="releaseId" value={target.releaseId} />

          <div>
            <h2 id="rollback-title" className="text-ink text-[15px] font-semibold tracking-tight">
              Roll back production?
            </h2>
            <p className="text-ink-2 mt-1.5 text-[13px] leading-relaxed">
              DeployHub will build and health check{" "}
              <Mono className="text-ink">{shortSha(target.commitSha)}</Mono> before it touches
              traffic, exactly as it would for a new deploy. Nothing on{" "}
              <Mono className="text-ink-2">{route}</Mono> changes until the older release is
              confirmed healthy.
            </p>
          </div>

          <dl className="border-line bg-canvas grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border px-3.5 py-3 text-[13px]">
            <dt className="text-ink-3">Returns to</dt>
            <dd className="min-w-0">
              <Mono className="text-ink">{shortSha(target.commitSha)}</Mono>
              <span className="text-ink-3 ml-2">deployed {formatAbsolute(target.deployedAt)}</span>
            </dd>

            <dt className="text-ink-3">Replaces</dt>
            <dd className="min-w-0">
              {liveCommitSha === undefined ? (
                <span className="text-ink-2">nothing is live</span>
              ) : (
                <Mono className="text-ink">{shortSha(liveCommitSha)}</Mono>
              )}
            </dd>
          </dl>

          {!state.ok && (
            <p className="text-bad text-[13px]" role="alert">
              {state.message}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <Confirm sha={shortSha(target.commitSha)} />
          </div>
        </form>
      </dialog>
    </>
  );
}

/** The verb names its object, so the last thing read before committing is the destination. */
function Confirm({ sha }: { sha: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" disabled={pending}>
      {pending ? "Queued…" : `Roll back to ${sha}`}
    </Button>
  );
}
