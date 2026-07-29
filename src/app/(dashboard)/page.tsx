import { Link } from "@/components/ui/link";
import { Button, Callout, EmptyState, Panel, SectionLabel } from "@/components/ui/primitives";
import { DeployButton } from "@/features/deployments/components/deploy-button";
import { DeploymentList } from "@/features/deployments/components/deployment-list";
import { LiveRefresh } from "@/features/deployments/components/live-refresh";
import { RollbackButton } from "@/features/deployments/components/rollback-button";
import { loadProduction } from "@/features/deployments/data";
import { ProductionHero } from "@/features/projects/components/production-hero";

/**
 * Production — the page you land on and leave open.
 *
 * Dynamic because it reads live state; there is nothing here to prerender. A dashboard whose home
 * page is cached is a dashboard that lies.
 */
export const dynamic = "force-dynamic";

export default async function ProductionPage() {
  const view = await loadProduction(5);

  if (view.kind === "unconfigured") {
    return <FirstRun />;
  }
  if (view.kind === "error") {
    return <StoreUnreachable code={view.code} message={view.message} />;
  }

  const { project, deployments } = view.history;
  const active = deployments.find((deployment) => deployment.id === project.activeDeploymentId);

  // Offer the rollback only when the domain would accept one: `assessRollback` refuses a paused
  // project and a project that already has a deployment in flight. Rendering the control anyway would
  // mean a confirmation dialog whose only possible outcome is a refusal.
  const rollbackTarget =
    project.enabled && project.activeDeploymentId === undefined
      ? project.rollbackTarget
      : undefined;

  return (
    <div className="flex flex-col gap-8">
      {/* The overview polls too, so a deployment started from a CLI or another browser appears here
          without a reload. Its signature is the active deployment and the newest row's state. */}
      <LiveRefresh
        live={project.activeDeploymentId !== undefined}
        signature={`${project.activeDeploymentId ?? "-"}:${active?.state ?? "-"}:${project.liveCommitSha ?? "-"}`}
      />

      <header className="flex items-baseline justify-between">
        <h1 className="text-[20px] font-semibold tracking-tight">{project.name}</h1>
      </header>

      <ProductionHero
        project={project}
        active={active}
        deployAction={
          <DeployButton
            targetRef={project.targetRef}
            activeDeploymentId={project.activeDeploymentId}
            disabledReason={
              project.enabled ? undefined : "Deploys are paused for this project in settings."
            }
          />
        }
        rollbackAction={
          rollbackTarget === undefined ? undefined : (
            <RollbackButton
              target={rollbackTarget}
              liveCommitSha={project.liveCommitSha}
              route={project.route}
            />
          )
        }
      />

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <SectionLabel>Recent deployments</SectionLabel>
          <Link
            href="/deployments"
            className="text-ink-2 hover:text-ink text-[13px] transition-colors duration-100"
          >
            View all →
          </Link>
        </div>
        <Panel className="overflow-hidden">
          <DeploymentList deployments={deployments} />
        </Panel>
      </section>
    </div>
  );
}

/** Nothing registered yet. One sentence, one instruction. */
function FirstRun() {
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-[20px] font-semibold tracking-tight">Welcome to DeployHub</h1>
      <Panel>
        <EmptyState
          title="No project registered"
          description="Register a repository and DeployHub will build it, health check it, and switch traffic to it with zero downtime."
          action={
            <Link href="/setup">
              <Button variant="primary" size="lg">
                Register a project
              </Button>
            </Link>
          }
        />
      </Panel>
    </div>
  );
}

/**
 * The store could not answer.
 *
 * Distinguished from "nothing registered" on purpose: one is a first run and the other is a
 * problem, and rendering them the same way would send someone to the setup form to fix a
 * permissions error.
 */
function StoreUnreachable({ code, message }: { code: string; message: string }) {
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-[20px] font-semibold tracking-tight">DeployHub</h1>
      <Callout tone="bad">
        <p className="text-ink font-medium">DeployHub cannot read its own store.</p>
        <p className="text-ink-2 mt-1.5">
          Deployments already on the server are unaffected — this is the dashboard, not the
          platform.
        </p>
        <p className="text-ink-3 mt-3 font-mono text-[12.5px]">
          {code} — {message}
        </p>
      </Callout>
    </div>
  );
}
