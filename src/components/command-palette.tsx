"use client";

/**
 * ⌘K, and the keyboard layer around it.
 *
 * The palette is the only place in the product where a list is filtered as you type, and it earns that
 * because it is the one list whose contents you already know the name of. Everything else is a screen
 * you navigate to.
 *
 * Deliberately commands, not records. A single-project tool has a small, closed command set, and a
 * palette that also searched deployments would mean loading them into the shell on every page just in
 * case — `g d` reaches the full, filterable history in two keystrokes instead.
 *
 * Rollback is **not** here. Its confirmation is a fact sheet naming the commit, when it shipped, and
 * what it replaces; reducing that to a fuzzy-matched Enter would remove the only part of the
 * interaction that matters. Deploy is here, and the palette stays open while it runs so a refusal —
 * "another deployment is already running" — is read rather than swallowed by a closing dialog.
 *
 * Commands are data with a `kind`, not closures. Two consequences, both deliberate: Enter and a mouse
 * click go through the *same* DOM button rather than two code paths that could drift, and Deploy is a
 * real `<button type="submit" form="…">` so the browser submits the form with no imperative call.
 *
 * Built on native `<dialog>`: focus trapping, `Esc`, top-layer stacking, and inertness of the page
 * behind it are all built in.
 */

import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Command as CommandIcon, Moon, Rocket, Sun } from "lucide-react";

import { deploy, setTheme } from "@/app/actions";
import { IDLE } from "@/lib/action-state";
import { type Theme, otherTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const DEPLOY_FORM = "palette-deploy";

type PaletteCommand = {
  readonly id: string;
  readonly label: string;
  /** Extra words the filter should match. Never rendered. */
  readonly keywords?: string;
  /** Shown right-aligned: the shortcut that does the same thing without the palette. */
  readonly shortcut?: string;
  readonly icon: ReactNode;
} & (
  | { readonly kind: "navigate"; readonly href: string }
  /** Submits the hidden form; the palette stays open so a refusal can be read. */
  | { readonly kind: "deploy" }
  | { readonly kind: "theme" }
);

const ICON = "size-3.5 shrink-0";

export function CommandPalette({
  theme,
  /** Present only when a deploy could actually be started. Absent while one runs, or if paused. */
  deployRef,
}: {
  theme: Theme;
  deployRef: string | undefined;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [current, setCurrent] = useState(theme);
  const [deployState, submitDeploy, deploying] = useActionState(deploy, IDLE);

  const open = useCallback(() => {
    setQuery("");
    setSelected(0);
    dialog.current?.showModal();
  }, []);

  /**
   * Flip the theme now, tell the server after.
   *
   * The attribute change is what the eye sees; the cookie is so the next server render agrees instead
   * of flashing back. In that order the toggle never waits on a round trip.
   */
  const toggleTheme = useCallback(() => {
    const next = otherTheme(current);
    document.documentElement.dataset.theme = next;
    setCurrent(next);
    void setTheme(next);
  }, [current]);

  const commands: readonly PaletteCommand[] = [
    {
      kind: "navigate",
      id: "production",
      href: "/",
      label: "Go to Production",
      keywords: "home overview live",
      shortcut: "g p",
      icon: <ArrowRight className={ICON} />,
    },
    {
      kind: "navigate",
      id: "deployments",
      href: "/deployments",
      label: "Go to Deployments",
      keywords: "history list",
      shortcut: "g d",
      icon: <ArrowRight className={ICON} />,
    },
    {
      kind: "navigate",
      id: "settings",
      href: "/settings",
      label: "Go to Settings",
      keywords: "configuration project pause",
      shortcut: "g s",
      icon: <ArrowRight className={ICON} />,
    },
    ...(deployRef === undefined
      ? []
      : [
          {
            kind: "deploy" as const,
            id: "deploy",
            label: `Deploy ${deployRef}`,
            keywords: "ship release build",
            icon: <Rocket className={ICON} />,
          },
        ]),
    {
      kind: "theme",
      id: "theme",
      label: current === "dark" ? "Switch to light theme" : "Switch to dark theme",
      keywords: "appearance dark light contrast",
      icon: current === "dark" ? <Sun className={ICON} /> : <Moon className={ICON} />,
    },
  ];

  const matches = commands.filter((command) => matchesQuery(command, query));
  // Clamp rather than reset, so deleting a character does not throw the selection away.
  const active = Math.min(selected, Math.max(0, matches.length - 1));

  /* -- The global keyboard layer ---------------------------------------- */

  useEffect(() => {
    /** `g` then a letter, and only for a moment — so `g` in a sentence is never a navigation. */
    let pendingGoUntil = 0;

    const onKeyDown = (event: KeyboardEvent) => {
      const element = dialog.current;
      const isOpen = element?.open === true;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (isOpen) {
          element?.close();
        } else {
          open();
        }
        return;
      }

      // Everything below is a bare key, which must never fire while someone is typing — including in
      // the palette's own filter.
      if (isOpen || isTyping(event.target)) {
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        open();
        return;
      }

      if (pendingGoUntil > Date.now()) {
        const destination = GO_TO[event.key.toLowerCase()];
        pendingGoUntil = 0;
        if (destination !== undefined) {
          event.preventDefault();
          router.push(destination);
        }
        return;
      }
      if (event.key.toLowerCase() === "g") {
        pendingGoUntil = Date.now() + 1_200;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, router]);

  return (
    <>
      {/* A real form, so the palette's Deploy runs the same server action — and gets the same
          idempotency key handling — as the button on the hero. */}
      {deployRef !== undefined && (
        <form id={DEPLOY_FORM} action={submitDeploy} className="hidden" />
      )}

      <button
        type="button"
        onClick={open}
        aria-keyshortcuts="Meta+K Control+K"
        aria-label="Open command palette"
        className="border-line text-ink-3 hover:border-line-strong hover:text-ink-2 hidden items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors duration-100 sm:flex"
      >
        <CommandIcon className="size-3" aria-hidden />K
      </button>

      <dialog
        ref={dialog}
        aria-label="Command palette"
        onClose={() => setQuery("")}
        className="border-line bg-raised text-ink shadow-modal mx-auto mt-[12vh] mb-auto w-[min(34rem,calc(100vw-2rem))] rounded-xl border p-0 backdrop:bg-black/60"
      >
        <div className="border-line border-b px-3 py-2.5">
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((index) => Math.min(index + 1, matches.length - 1));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((index) => Math.max(index - 1, 0));
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                // Click the selected row rather than duplicating what it does. Keyboard and mouse
                // then provably take the same path, including the form submission.
                event.currentTarget
                  .closest("dialog")
                  ?.querySelector<HTMLButtonElement>('[data-selected="true"]')
                  ?.click();
              }
            }}
            placeholder="Search commands…"
            aria-label="Search commands"
            aria-controls="palette-list"
            className="text-ink placeholder:text-ink-3 w-full bg-transparent px-1 text-sm outline-none"
          />
        </div>

        <ul id="palette-list" className="scroll-quiet max-h-[min(60vh,22rem)] overflow-auto py-1.5">
          {matches.length === 0 ? (
            <li className="text-ink-3 px-4 py-6 text-center text-[13px]">No matching command.</li>
          ) : (
            matches.map((command, index) => (
              <li key={command.id}>
                <button
                  type={command.kind === "deploy" ? "submit" : "button"}
                  form={command.kind === "deploy" ? DEPLOY_FORM : undefined}
                  /* `onMouseMove`, not `onMouseEnter`: entering fires when the list scrolls under a
                     stationary pointer, which would steal the selection from the arrow keys. */
                  onMouseMove={() => setSelected(index)}
                  onClick={(event) => {
                    if (command.kind === "navigate") {
                      // Close first: a route change with a modal still open leaves the page behind
                      // it inert.
                      event.currentTarget.closest("dialog")?.close();
                      router.push(command.href);
                      return;
                    }
                    if (command.kind === "theme") {
                      toggleTheme();
                    }
                    // `deploy` submits natively, and the palette stays open to show any refusal.
                  }}
                  data-selected={index === active ? "true" : undefined}
                  aria-current={index === active ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors duration-75",
                    index === active ? "bg-surface text-ink" : "text-ink-2",
                  )}
                >
                  <span className="text-ink-3" aria-hidden>
                    {command.icon}
                  </span>
                  <span className="flex-1 truncate">
                    {command.kind === "deploy" && deploying ? "Queued…" : command.label}
                  </span>
                  {command.shortcut !== undefined && (
                    <kbd className="text-ink-3 font-mono text-[11px]">{command.shortcut}</kbd>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>

        {!deployState.ok && (
          <p className="text-bad border-line border-t px-3 py-2 text-[12px]" role="alert">
            {deployState.message}
          </p>
        )}

        <div className="border-line text-ink-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-[11px]">
          <Hint keys="↑ ↓">navigate</Hint>
          <Hint keys="↵">run</Hint>
          <Hint keys="esc">close</Hint>
          <Hint keys="g p · g d · g s">jump</Hint>
        </div>
      </dialog>
    </>
  );
}

function Hint({ keys, children }: { keys: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="border-line bg-canvas rounded border px-1 py-0.5 font-mono">{keys}</kbd>
      {children}
    </span>
  );
}

const GO_TO: Readonly<Record<string, string>> = {
  p: "/",
  d: "/deployments",
  s: "/settings",
};

function matchesQuery(command: PaletteCommand, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  const haystack = `${command.label} ${command.keywords ?? ""}`.toLowerCase();
  // Every word must appear somewhere. Enough for a list this size, and it never surprises: there is no
  // fuzzy ranking that quietly puts the wrong command first.
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * Whether a field is being typed in.
 *
 * Without this, `?` in a repository URL opens the palette and `g` in a project name navigates away
 * mid-word — the two bugs every keyboard layer ships with once.
 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
