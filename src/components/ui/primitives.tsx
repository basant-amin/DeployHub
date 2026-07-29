/**
 * The primitive kit. Written in the shadcn idiom (`cn` + `cva`) rather than generated, because
 * the whole set is small enough to read in one sitting and there is no Radix behaviour any of
 * them need.
 *
 * Everything here is a Server Component. Nothing in this file holds state.
 */

import { type VariantProps, cva } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/* -- Button ------------------------------------------------------------- */

export const buttonStyles = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors duration-100 disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /* The accent appears here and on focus rings. Nowhere else. */
        primary: "bg-accent text-accent-ink hover:bg-accent/90",
        secondary:
          "border border-line bg-surface text-ink hover:border-line-strong hover:bg-raised",
        ghost: "text-ink-2 hover:bg-raised hover:text-ink",
        danger: "border border-bad/40 bg-bad-bg text-bad hover:border-bad/70",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-9 px-4 text-[13px]",
        lg: "h-10 px-5 text-sm",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonStyles>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}

/* -- Panel: the only container ------------------------------------------ */

/**
 * A hairline-bordered surface. There is exactly one container primitive on purpose: a product
 * with three subtly different card styles has none.
 */
export function Panel({
  className,
  children,
  ...props
}: ComponentProps<"section"> & { children: ReactNode }) {
  return (
    <section className={cn("border-line bg-surface rounded-lg border", className)} {...props}>
      {children}
    </section>
  );
}

/** A 12px uppercase label. Used for the one-word headings above lists. */
export function SectionLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <h2
      className={cn("text-ink-3 text-[12px] font-semibold tracking-[0.06em] uppercase", className)}
    >
      {children}
    </h2>
  );
}

/* -- Mono: exact machine values ---------------------------------------- */

/**
 * Monospace is a semantic signal here, not decoration: it means *this is an exact machine value
 * you may want to copy* — a sha, a digest, a port, a container name, a duration.
 */
export function Mono({
  className,
  children,
  title,
}: {
  className?: string;
  children: ReactNode;
  /** `undefined` is meaningful: the full value may not be known yet. */
  title?: string | undefined;
}) {
  return (
    <span className={cn("font-mono text-[13px]", className)} title={title} data-numeric>
      {children}
    </span>
  );
}

/* -- Empty state -------------------------------------------------------- */

/** One sentence and the one action that resolves it. No illustrations. */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <p className="text-ink text-sm font-medium">{title}</p>
      <p className="text-ink-2 max-w-sm text-[13px]">{description}</p>
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}

/* -- Skeleton ----------------------------------------------------------- */

/**
 * Fixed geometry, no shimmer.
 *
 * A skeleton exists to stop layout shift, and a shimmering gradient is motion that carries no
 * information — which this design system does not permit.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("bg-raised rounded-md", className)} />;
}

/* -- Callout ------------------------------------------------------------ */

const calloutStyles = cva("rounded-lg border px-4 py-3 text-[13px]", {
  variants: {
    tone: {
      neutral: "border-line bg-surface text-ink-2",
      ok: "border-ok/30 bg-ok-bg text-ink",
      warn: "border-warn/35 bg-warn-bg text-ink",
      bad: "border-bad/35 bg-bad-bg text-ink",
      alarm: "border-bad/60 bg-bad-bg-strong text-ink",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export type CalloutProps = ComponentProps<"div"> & VariantProps<typeof calloutStyles>;

/**
 * Inline and permanent, never a toast.
 *
 * A deployment failure has to survive a refresh and still be readable an hour later; a toast is
 * for something you may miss and need not remember.
 */
export function Callout({ className, tone, ...props }: CalloutProps) {
  return <div className={cn(calloutStyles({ tone }), className)} {...props} />;
}
