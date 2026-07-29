import type { Metadata } from "next";

import { setProjectEnabled, updateProject } from "@/app/actions";
import { Link } from "@/components/ui/link";
import { Button, Callout, Mono, Panel, SectionLabel } from "@/components/ui/primitives";
import { ProjectForm } from "@/features/projects/components/project-form";
import { valuesFromProject } from "@/features/projects/form-values";
import { getPlatform } from "@/server/runtime/platform";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings" };

/**
 * The project's configuration, editable.
 *
 * The same form as `/setup`, prefilled, with the slug locked. There is no delete: a project is taken
 * out of service by pausing it, which keeps the configuration and the history of what it was. A
 * dashboard button that destroys a deployment record is a button that eventually gets pressed during
 * an incident.
 */
export default async function SettingsPage() {
  const projects = await getPlatform().projects.list();

  if (!projects.ok) {
    return (
      <Callout tone="bad">
        <p className="text-ink font-medium">DeployHub cannot read its own store.</p>
        <p className="text-ink-3 mt-2 font-mono text-[12.5px]">
          {projects.error.code} — {projects.error.message}
        </p>
      </Callout>
    );
  }

  const project = projects.value[0];
  if (project === undefined) {
    return (
      <Callout tone="neutral">
        <p className="text-ink font-medium">No project registered</p>
        <p className="mt-1">
          <Link href="/setup" className="decoration-line underline underline-offset-4">
            Register a project
          </Link>{" "}
          to start deploying.
        </p>
      </Callout>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-[20px] font-semibold tracking-tight">Settings</h1>
        <p className="text-ink-2 text-[13px]">
          Configuration for <span className="text-ink font-medium">{project.name}</span>. Changes
          apply to the next deployment; nothing currently live is touched.
        </p>
      </header>

      <DeploymentSwitch enabled={project.enabled} slug={project.slug} />

      <ProjectForm
        action={updateProject}
        values={valuesFromProject(project.toJSON())}
        mode="edit"
        submitLabel="Save configuration"
      />
    </div>
  );
}

/**
 * Pause and resume, stated as what it does to production rather than as a toggle.
 *
 * A switch labelled only "Enabled" makes the reader guess whether flipping it stops the running
 * container. It does not, and saying so is the entire value of this panel.
 */
function DeploymentSwitch({ enabled, slug }: { enabled: boolean; slug: string }) {
  return (
    <Panel className={enabled ? "px-5 py-4" : "border-warn/35 bg-warn-bg px-5 py-4"}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <SectionLabel>Deployments</SectionLabel>
          <p className="text-ink mt-1.5 text-[13px] font-medium">
            {enabled ? "Accepting deployments" : "Paused"}
          </p>
          <p className="text-ink-2 mt-1 max-w-xl text-[13px] leading-relaxed">
            {enabled ? (
              <>
                Pausing refuses new deployments of <Mono className="text-ink-2">{slug}</Mono>.
                Whatever is live stays live and keeps serving traffic — this stops new ones
                starting, it does not stop the application.
              </>
            ) : (
              <>
                New deployments are refused. Whatever was live is still live and still serving
                traffic; rollback is unavailable until this is resumed.
              </>
            )}
          </p>
        </div>

        <form action={setProjectEnabled} className="shrink-0">
          <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
          <Button type="submit" variant={enabled ? "secondary" : "primary"}>
            {enabled ? "Pause deployments" : "Resume deployments"}
          </Button>
        </form>
      </div>
    </Panel>
  );
}
