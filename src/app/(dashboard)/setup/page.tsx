import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Callout } from "@/components/ui/primitives";
import { registerProject } from "@/app/actions";
import { ProjectForm } from "@/features/projects/components/project-form";
import { newProjectValues } from "@/features/projects/form-values";
import { getPlatform } from "@/server/runtime/platform";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Register a project" };

/**
 * First run.
 *
 * Reachable only when nothing is registered — with a project in place this redirects to settings,
 * because a "register" screen that silently edits an existing project is a trap, and one that creates
 * a second project would break the single-project assumption everywhere else.
 */
export default async function SetupPage() {
  const projects = await getPlatform().projects.list();

  if (!projects.ok) {
    return (
      <Callout tone="bad">
        <p className="text-ink font-medium">DeployHub cannot read its own store.</p>
        <p className="text-ink-2 mt-1.5">
          Nothing can be registered until it can. Check the database file and its permissions.
        </p>
        <p className="text-ink-3 mt-3 font-mono text-[12.5px]">
          {projects.error.code} — {projects.error.message}
        </p>
      </Callout>
    );
  }

  if (projects.value.length > 0) {
    redirect("/settings");
  }

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-[20px] font-semibold tracking-tight">Register a project</h1>
        <p className="text-ink-2 max-w-2xl text-[13px] leading-relaxed">
          DeployHub needs to know where the code is, how to build it, and how to tell that a build
          works. Four fields are genuinely required — a name, a repository, the port your
          application listens on, and the host it serves. Everything else has a working default.
        </p>
      </header>

      <Callout tone="neutral">
        <p className="text-ink font-medium">Secrets are named here, not entered</p>
        <p className="mt-1.5 leading-relaxed">
          The git credential and the runtime environment are references to entries in
          DeployHub&apos;s secrets file on the server — a file with mode 0600 that this dashboard
          can read but never write. Nothing you type on this page is a secret, which is what makes
          the whole configuration safe to log, persist, and show back to you.
        </p>
      </Callout>

      <ProjectForm
        action={registerProject}
        values={newProjectValues()}
        mode="create"
        submitLabel="Register project"
      />
    </div>
  );
}
