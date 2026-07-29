/**
 * The gate's front door.
 *
 * Deliberately the plainest screen in the product: one field, one button, and — when there is no
 * password configured — the exact instruction that fixes it. An internal tool whose login page makes
 * you guess at a misconfiguration wastes the hour it was supposed to save.
 */

import type { Metadata } from "next";

import { Panel } from "@/components/ui/primitives";
import { isConfigured } from "@/lib/session";

import { SignInForm } from "./sign-in-form";

/* The root layout's template appends "· DeployHub"; repeating it here would say it twice. */
export const metadata: Metadata = { title: "Sign in" };

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  const params = await searchParams;
  const configured = isConfigured(process.env.DEPLOYHUB_PASSWORD);

  return (
    /* Full height, not height-minus-a-top-bar: this page deliberately has no chrome. */
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5 py-16">
      <div className="mb-8">
        <p className="text-ink text-[15px] font-semibold tracking-tight">DeployHub</p>
        <p className="text-ink-2 mt-1 text-[13px]">
          {configured
            ? "Enter the shared password to continue."
            : "This instance is not configured yet."}
        </p>
      </div>

      {configured ? (
        <SignInForm next={typeof params.next === "string" ? params.next : undefined} />
      ) : (
        <Unconfigured />
      )}
    </main>
  );
}

/**
 * No password set.
 *
 * The dashboard fails closed rather than serving unauthenticated — a tool whose main verb is
 * "change what production is running" does not get an open-by-default mode.
 */
function Unconfigured() {
  return (
    <Panel className="p-5">
      <p className="text-ink text-[13px] font-medium">Set a password to sign in</p>
      <p className="text-ink-2 mt-2 text-[13px] leading-relaxed">
        DeployHub uses one shared password for the whole team. Set{" "}
        <code className="text-ink font-mono text-[12px]">DEPLOYHUB_PASSWORD</code> to at least eight
        characters and restart the server.
      </p>
      {/* Short enough to fit the panel: a line that scrolls sideways reads as truncated even when
          it is not, and the point of this box is that it can be copied at a glance. */}
      <pre className="border-line bg-canvas text-ink-2 scroll-quiet mt-3 overflow-x-auto rounded-md border px-3 py-2 font-mono text-[12px]">
        DEPLOYHUB_PASSWORD=&lt;random&gt;
      </pre>
      <p className="text-ink-3 mt-3 text-[12px] leading-relaxed">
        Generate one with <code className="text-ink-2 font-mono">openssl rand -hex 24</code>. Until
        it is set, every page redirects here and no deployment can be triggered from the dashboard.
      </p>
    </Panel>
  );
}
