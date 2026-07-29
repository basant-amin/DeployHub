/**
 * What a server action hands back to the control that invoked it.
 *
 * Its own module because both sides need it: the actions produce it on the server, the buttons
 * render it on the client, and a client component must not import a `"use server"` file for a type.
 *
 * Failures are returned, not thrown. A failed deploy request is an ordinary answer — "something else
 * is already deploying" is information, not an exception — and returning it means the message lands
 * next to the button that caused it instead of replacing the page with an error screen.
 */

export interface ActionState {
  readonly ok: boolean;
  /** Shown inline beside the control. Never a toast; toasts are missable and this matters. */
  readonly message?: string | undefined;
  /** The domain error code, for the copy-diagnostics affordance. */
  readonly code?: string | undefined;
}

export const IDLE: ActionState = { ok: true };
