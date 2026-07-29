"use client";

/**
 * The one field.
 *
 * Client only because it needs `useActionState` to show the failure inline; the surrounding page is a
 * Server Component. `useFormStatus` reads the pending state of the enclosing form, which keeps the
 * submit button honest without a second piece of state to fall out of sync.
 */

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { signIn } from "@/app/actions";
import { Button } from "@/components/ui/primitives";
import { IDLE } from "@/lib/action-state";

export function SignInForm({ next }: { next: string | undefined }) {
  const [state, action] = useActionState(signIn, IDLE);

  return (
    <form action={action} className="flex flex-col gap-3">
      {next !== undefined && <input type="hidden" name="next" value={next} />}

      <label className="flex flex-col gap-1.5">
        <span className="text-ink-2 text-[13px]">Password</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus
          required
          aria-invalid={state.ok ? undefined : true}
          aria-describedby={state.ok ? undefined : "signin-error"}
          className="border-line bg-surface text-ink placeholder:text-ink-3 focus-visible:border-line-strong aria-invalid:border-bad/60 h-10 rounded-md border px-3 text-sm outline-none"
        />
      </label>

      {/* Reserved height, so the form does not jump when the message appears. */}
      <p id="signin-error" className="text-bad min-h-4 text-[13px]" role="alert">
        {state.ok ? "" : state.message}
      </p>

      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="lg" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </Button>
  );
}
