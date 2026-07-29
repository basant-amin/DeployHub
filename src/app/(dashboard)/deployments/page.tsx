import type { Metadata } from "next";

import type { DeploymentSummary } from "@/core/application";
import { Callout, Panel } from "@/components/ui/primitives";
import { DeploymentList } from "@/features/deployments/components/deployment-list";
import { loadHistory } from "@/features/deployments/data";
import { cn } from "@/lib/utils";

import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Deployments" };

type Filter = "all" | "succeeded" | "failed" | "rolled_back";

const FILTERS: readonly { readonly value: Filter; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "rolled_back", label: "Rolled back" },
];

/**
 * History.
 *
 * The same rows as `/`, filterable. The filter lives in the URL rather than in React state, so any
 * view here can be pasted to someone else — which is the whole reason to have a history page.
 *
 * No table headers, no sort controls, no checkboxes: there are no bulk operations on deployments
 * and there never should be.
 */
export default async function DeploymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: raw } = await searchParams;
  const filter: Filter = isFilter(raw) ? raw : "all";

  const view = await loadHistory(50);
  if (view.kind === "unconfigured") {
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
  if (view.kind === "error") {
    return (
      <Callout tone="bad">
        <p className="text-ink font-medium">DeployHub cannot read its own store.</p>
        <p className="text-ink-3 mt-2 font-mono text-[12.5px]">
          {view.code} — {view.message}
        </p>
      </Callout>
    );
  }

  const shown = view.deployments.filter((deployment) => matches(deployment, filter));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[20px] font-semibold tracking-tight">Deployments</h1>
        <nav className="flex items-center gap-1" aria-label="Filter deployments">
          {FILTERS.map((option) => (
            <Link
              key={option.value}
              href={option.value === "all" ? "/deployments" : `/deployments?filter=${option.value}`}
              aria-current={option.value === filter ? "page" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-100",
                option.value === filter
                  ? "bg-raised text-ink"
                  : "text-ink-2 hover:bg-raised hover:text-ink",
              )}
            >
              {option.label}
            </Link>
          ))}
        </nav>
      </div>

      <Panel className="overflow-hidden">
        <DeploymentList deployments={shown} />
      </Panel>

      {shown.length > 0 && (
        <p className="text-ink-3 text-[13px]">
          Showing {shown.length} of {view.deployments.length} recorded deployments.
        </p>
      )}
    </div>
  );
}

function isFilter(value: string | undefined): value is Filter {
  return value === "succeeded" || value === "failed" || value === "rolled_back" || value === "all";
}

/**
 * "Failed" means *did not ship*, which includes the states a reader would not think to look for
 * separately — an interrupted deployment and a failed rollback both failed to deliver.
 */
function matches(deployment: DeploymentSummary, filter: Filter): boolean {
  switch (filter) {
    case "succeeded":
      return deployment.state === "succeeded";
    case "failed":
      return (
        deployment.state === "failed" ||
        deployment.state === "rollback_failed" ||
        deployment.state === "interrupted"
      );
    case "rolled_back":
      return deployment.state === "rolled_back";
    default:
      return true;
  }
}
