"use client";

/**
 * The project form — the one screen in DeployHub with more than one input.
 *
 * A Client Component because inline per-field errors are the whole point: a configuration screen that
 * reveals one problem per attempt is a bad screen, and the domain already reports every bad field at
 * once. `useActionState` is what carries that list back without a page of its own.
 *
 * It is driven entirely by `PROJECT_FORM`, so adding a field is one entry in a data file rather than
 * an input here, a name in a mapping table, and a line in a marshaller.
 *
 * Values are `defaultValue`, not controlled state. Twenty-one controlled inputs would mean twenty-one
 * re-renders per keystroke to gain nothing: the browser already holds form state perfectly well, and
 * a failed submission redisplays from the server's copy of what was sent.
 */

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";

import { Button, Callout, SectionLabel } from "@/components/ui/primitives";
import type { ProjectFormState } from "@/lib/action-state";
import { cn } from "@/lib/utils";

import { type FieldSpec, PROJECT_FIELD_NAMES, PROJECT_FORM } from "../form-spec";

export function ProjectForm({
  action,
  values,
  mode,
  submitLabel,
}: {
  action: (state: ProjectFormState, form: FormData) => Promise<ProjectFormState>;
  values: Readonly<Record<string, string>>;
  /** `create` on /setup, `edit` on /settings — only the slug behaves differently. */
  mode: "create" | "edit";
  submitLabel: string;
}) {
  const [state, submit] = useActionState(action, { ok: true });

  // A failed attempt redisplays what was sent, so nothing typed is ever lost.
  const shown = state.values ?? values;
  const errors = state.byField ?? {};

  /**
   * Take the reader to the first problem.
   *
   * Twenty-one fields is tall enough that a rejected submission can leave every error below the fold,
   * and a summary saying "6 fields need attention" with nothing visibly wrong is worse than no
   * summary. Keyed on `state` rather than a flag: `useActionState` returns a new object per
   * submission, so this fires again even when the same field fails twice.
   */
  useEffect(() => {
    if (state.ok || state.byField === undefined) {
      return;
    }
    const byField = state.byField;
    const first = PROJECT_FIELD_NAMES.find((name) => (byField[name]?.length ?? 0) > 0);
    if (first === undefined) {
      return;
    }
    const element = document.getElementById(first);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({
      block: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [state]);

  return (
    <form action={submit} className="flex flex-col gap-8">
      {state.message !== undefined && (
        /* Tone follows the outcome. A red box saying "Configuration saved." is a bug report. */
        <Callout tone={state.ok ? "ok" : "bad"}>
          <p className="text-ink font-medium">{state.message}</p>
          {state.general !== undefined && state.general.length > 0 && (
            <ul className="text-ink-2 mt-2 flex flex-col gap-1">
              {state.general.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          {state.code !== undefined && (
            <p className="text-ink-3 mt-2 font-mono text-[12px]">{state.code}</p>
          )}
        </Callout>
      )}

      {PROJECT_FORM.map((group) => (
        <section key={group.title} className="flex flex-col gap-4">
          <div>
            <SectionLabel>{group.title}</SectionLabel>
            <p className="text-ink-3 mt-1.5 max-w-2xl text-[13px] leading-relaxed">
              {group.caption}
            </p>
          </div>

          <div
            className={cn(
              "grid gap-x-6 gap-y-5",
              group.columns === 2 ? "sm:grid-cols-2" : "grid-cols-1",
            )}
          >
            {group.fields.map((field) => (
              <Field
                key={field.name}
                field={field}
                value={shown[field.name] ?? ""}
                errors={errors[field.name] ?? []}
                readOnly={mode === "edit" && field.fixedAfterCreate === true}
              />
            ))}
          </div>
        </section>
      ))}

      <div className="border-line flex items-center gap-3 border-t pt-6">
        <Submit label={submitLabel} />
        <Pending />
      </div>
    </form>
  );
}

function Field({
  field,
  value,
  errors,
  readOnly,
}: {
  field: FieldSpec;
  value: string;
  errors: readonly string[];
  readOnly: boolean;
}) {
  const invalid = errors.length > 0;
  const describedBy = invalid
    ? `${field.name}-error`
    : field.hint !== undefined
      ? `${field.name}-hint`
      : undefined;

  const shared = cn(
    "border-field bg-surface text-ink placeholder:text-ink-3 w-full rounded-md border px-3 text-sm outline-none transition-colors duration-100",
    "focus-visible:border-ink-3",
    invalid && "border-bad/60",
    readOnly && "text-ink-2 bg-canvas cursor-not-allowed",
  );

  return (
    <div className={cn("flex flex-col gap-1.5", field.kind === "textarea" && "sm:col-span-2")}>
      <label htmlFor={field.name} className="text-ink text-[13px] font-medium">
        {field.label}
      </label>

      {field.kind === "textarea" ? (
        <textarea
          id={field.name}
          name={field.name}
          defaultValue={value}
          placeholder={field.placeholder}
          readOnly={readOnly}
          rows={3}
          spellCheck={false}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          className={cn(shared, "scroll-quiet resize-y py-2 font-mono text-[12.5px]")}
        />
      ) : (
        <input
          id={field.name}
          name={field.name}
          /* `inputMode` rather than `type="number"`: spinners on a port number are noise, and a
             scroll wheel over a focused number input silently changes it. */
          type="text"
          inputMode={field.kind === "number" ? "numeric" : undefined}
          defaultValue={value}
          placeholder={field.placeholder}
          readOnly={readOnly}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          className={cn(shared, "h-9", field.kind === "number" && "font-mono")}
        />
      )}

      {invalid ? (
        <p id={`${field.name}-error`} className="text-bad text-[12px]" role="alert">
          {errors.join(" · ")}
        </p>
      ) : (
        field.hint !== undefined && (
          <p id={`${field.name}-hint`} className="text-ink-3 text-[12px] leading-relaxed">
            {field.hint}
          </p>
        )
      )}
    </div>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="lg" disabled={pending}>
      {pending ? "Saving…" : label}
    </Button>
  );
}

/** Nothing here is slow, but a form that looks inert after a click gets clicked twice. */
function Pending() {
  const { pending } = useFormStatus();
  return pending ? <span className="text-ink-3 text-[13px]">validating…</span> : null;
}
