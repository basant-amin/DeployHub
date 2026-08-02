"use server";

/**
 * Server actions — the only way the dashboard changes anything.
 *
 * Each one is a thin call into a use case. No orchestration lives here: the engine decides what a
 * deploy does and the domain decides whether a rollback is allowed. This file's entire job is to
 * turn a form submission into a use-case call, and a `Result` into something a button can render.
 *
 * Every mutating action re-checks the session. Middleware already gates navigation, but a server
 * action is a separately addressable endpoint, and "the page was protected" is not the same claim as
 * "the mutation was protected".
 */

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  type Actor as ActorId,
  type ProjectId,
  type Result,
  Actor,
  DeploymentError,
  GitRef,
  IdempotencyKey,
  ReleaseId,
  err,
  ok,
} from "@/core/shared";
import { Project } from "@/core/domain";
import { PROJECT_ISSUE_PATHS } from "@/features/projects/form-spec";
import { projectInputFromForm } from "@/features/projects/form-values";
import { attributeIssues } from "@/features/projects/issues";
import type { ActionState, ProjectFormState } from "@/lib/action-state";
import { SESSION_COOKIE, expectedToken, isConfigured, tokensMatch } from "@/lib/session";
import { THEME_COOKIE, type Theme } from "@/lib/theme";
import { getPlatform } from "@/server/runtime/platform";

/* -- Sign in ------------------------------------------------------------- */

export async function signIn(_previous: ActionState, form: FormData): Promise<ActionState> {
  const password = process.env.DEPLOYHUB_PASSWORD;
  if (!isConfigured(password)) {
    return {
      ok: false,
      message:
        "DeployHub has no password set. Set DEPLOYHUB_PASSWORD to at least 8 characters and restart.",
    };
  }

  const presented = form.get("password");
  if (typeof presented !== "string" || !tokensMatch(presented, password)) {
    // Deliberately uniform: nothing here distinguishes empty from wrong from too short.
    return { ok: false, message: "That password is not correct." };
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, await expectedToken(password), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Secure in production; a development session over plain http must still work.
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
  });

  const next = form.get("next");
  redirect(typeof next === "string" && next.startsWith("/") ? next : "/");
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/signin");
}

/* -- Deploy -------------------------------------------------------------- */

/**
 * Queue a deployment, then go straight to its detail page.
 *
 * The redirect is the point. Staying on the overview would hide the log, which is the one thing a
 * person wants the moment a deploy starts — and it means the optimistic "Queued…" state on the
 * button only ever has to survive a single navigation.
 */
export async function deploy(_previous: ActionState, form: FormData): Promise<ActionState> {
  const denied = await requireSession();
  if (denied !== undefined) {
    return denied;
  }

  const project = await resolveProjectId();
  if (!project.ok) {
    return toState(project.error);
  }

  // An explicit ref is the redeploy-a-branch case; omitted means the project's configured ref.
  const raw = form.get("ref");
  const wanted = typeof raw === "string" ? raw.trim() : "";
  const ref = wanted === "" ? undefined : GitRef.parse(wanted);
  if (ref !== undefined && !ref.ok) {
    return toState(ref.error);
  }

  const actor = await currentActor();
  if (!actor.ok) {
    return toState(actor.error);
  }

  const key = mintIdempotencyKey();
  if (!key.ok) {
    return toState(key.error);
  }

  const requested = await getPlatform().requestDeployment.execute({
    projectId: project.value,
    actor: actor.value,
    idempotencyKey: key.value,
    ...(ref === undefined ? {} : { targetRef: ref.value }),
  });
  if (!requested.ok) {
    return toState(requested.error);
  }

  revalidatePath("/");
  revalidatePath("/deployments");
  redirect(`/deployments/${requested.value.deployment.id}`);
}

/* -- Rollback ------------------------------------------------------------ */

/**
 * Queue a rollback of production to an earlier release.
 *
 * It runs the same pipeline as any deploy — validated, locked, health-checked, verified through the
 * public route — so it lands on a detail page that looks like every other one.
 */
export async function rollback(_previous: ActionState, form: FormData): Promise<ActionState> {
  const denied = await requireSession();
  if (denied !== undefined) {
    return denied;
  }

  const raw = form.get("releaseId");
  const releaseId = ReleaseId.parse(typeof raw === "string" ? raw : "");
  if (!releaseId.ok) {
    return toState(releaseId.error);
  }

  const project = await resolveProjectId();
  if (!project.ok) {
    return toState(project.error);
  }

  const actor = await currentActor();
  if (!actor.ok) {
    return toState(actor.error);
  }

  const key = mintIdempotencyKey();
  if (!key.ok) {
    return toState(key.error);
  }

  const requested = await getPlatform().requestRollback.execute({
    projectId: project.value,
    releaseId: releaseId.value,
    actor: actor.value,
    idempotencyKey: key.value,
  });
  if (!requested.ok) {
    return toState(requested.error);
  }

  revalidatePath("/");
  revalidatePath("/deployments");
  redirect(`/deployments/${requested.value.id}`);
}

/* -- Appearance ----------------------------------------------------------- */

/**
 * Remember the chosen theme.
 *
 * No session check: this changes nothing about the platform and a signed-out sign-in page is entitled
 * to a theme. It also does not redirect or revalidate — the client flips `data-theme` itself for
 * instant feedback, and this exists so the *next* server render agrees rather than flashing back.
 */
export async function setTheme(theme: Theme): Promise<void> {
  const store = await cookies();
  store.set(THEME_COOKIE, theme, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

/* -- Project configuration ----------------------------------------------- */

/**
 * Register the project.
 *
 * Release 1 has one, so this refuses a second rather than pretending to support many and failing
 * somewhere less obvious.
 */
export async function registerProject(
  _previous: ProjectFormState,
  form: FormData,
): Promise<ProjectFormState> {
  const denied = await requireSession();
  if (denied !== undefined) {
    return denied;
  }

  const platform = getPlatform();
  const existing = await platform.projects.list();
  if (!existing.ok) {
    return toState(existing.error);
  }
  if (existing.value.length > 0) {
    return {
      ok: false,
      message: "A project is already registered. Change its configuration in settings instead.",
    };
  }

  const { input, values } = projectInputFromForm(form, { id: mintProjectId(), enabled: true });
  const project = Project.create(input);
  if (!project.ok) {
    return formFailure(project.error, values);
  }

  const saved = await platform.projects.save(project.value);
  if (!saved.ok) {
    return { ...toState(saved.error), values };
  }

  revalidatePath("/");
  revalidatePath("/settings");
  redirect("/");
}

/**
 * Change the project's configuration.
 *
 * The id, the slug, and the enabled flag are carried over rather than read from the form. The slug in
 * particular: it is embedded in container names, image repositories, and the workspace path, so
 * changing it would not rename anything — it would orphan everything already on the server. The form
 * shows it read-only and this is the half of that promise that actually holds.
 */
export async function updateProject(
  _previous: ProjectFormState,
  form: FormData,
): Promise<ProjectFormState> {
  const denied = await requireSession();
  if (denied !== undefined) {
    return denied;
  }

  const platform = getPlatform();
  const current = await loadOnlyProject();
  if (!current.ok) {
    return toState(current.error);
  }

  const { input, values } = projectInputFromForm(form, {
    id: current.value.id,
    enabled: current.value.enabled,
    slug: current.value.slug,
    containerName: current.value.config.containerName,
  });

  const project = Project.create(input);
  if (!project.ok) {
    return formFailure(project.error, values);
  }

  const saved = await platform.projects.save(project.value);
  if (!saved.ok) {
    return { ...toState(saved.error), values };
  }

  revalidatePath("/");
  revalidatePath("/settings");
  return { ok: true, message: "Configuration saved." };
}

/**
 * Pause or resume deployments.
 *
 * A disabled project keeps its configuration, its history, and whatever it has live — it simply
 * refuses new deployments. This is how a project is taken out of service without destroying the record
 * of what it was, which is why there is no delete here.
 */
export async function setProjectEnabled(form: FormData): Promise<void> {
  const denied = await requireSession();
  if (denied !== undefined) {
    return;
  }

  const current = await loadOnlyProject();
  if (!current.ok) {
    return;
  }

  const enable = form.get("enabled") === "true";
  const updated = enable ? current.value.enable() : current.value.disable();
  await getPlatform().projects.save(updated);

  revalidatePath("/");
  revalidatePath("/settings");
}

/* -- Shared -------------------------------------------------------------- */

/** `undefined` means the caller may proceed. Anything else is the refusal to render. */
async function requireSession(): Promise<ActionState | undefined> {
  const password = process.env.DEPLOYHUB_PASSWORD;
  if (!isConfigured(password)) {
    return { ok: false, message: "DeployHub has no password set, so it will not act." };
  }
  const store = await cookies();
  return tokensMatch(store.get(SESSION_COOKIE)?.value, await expectedToken(password))
    ? undefined
    : { ok: false, message: "Your session is no longer valid. Reload and sign in again." };
}

/** Release 1 has one project: whichever is registered. */
async function resolveProjectId(): Promise<Result<ProjectId>> {
  const projects = await getPlatform().projects.list();
  if (!projects.ok) {
    return projects;
  }
  const project = projects.value[0];
  return project === undefined
    ? err(
        DeploymentError.of("PROJECT_NOT_FOUND", "No project is registered yet.", {
          details: {},
        }),
      )
    : ok(project.id);
}

/**
 * Who did it.
 *
 * A shared password identifies a team rather than a person, so the actor is the team. When real
 * accounts arrive this reads the signed-in user and nothing downstream changes — the audit trail is
 * already recorded per deployment.
 */
async function currentActor(): Promise<Result<ActorId>> {
  return Actor.parse(process.env.DEPLOYHUB_ACTOR ?? "dashboard");
}

/**
 * One key per invocation.
 *
 * The key exists so that a resubmitted form — a refresh, a double submit, a flaky connection that
 * retried — returns the deployment it already created instead of racing for the lock. A deliberate
 * second click is a new intent and gets a new key.
 */
function mintIdempotencyKey(): Result<IdempotencyKey> {
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  return IdempotencyKey.parse(`ui-${Date.now().toString(36)}-${random}`);
}

function toState(error: DeploymentError): ActionState {
  return { ok: false, code: error.code, message: error.message };
}

/**
 * A domain validation failure, split across the inputs that caused it.
 *
 * The message deliberately does not repeat the issues: they are about to appear beside their own
 * fields, and saying each one twice makes the reader check whether they are the same problem.
 */
function formFailure(
  error: DeploymentError,
  values: Readonly<Record<string, string>>,
): ProjectFormState {
  const { byField, general } = attributeIssues(error.issues, PROJECT_ISSUE_PATHS);
  const count = Object.keys(byField).length + general.length;

  return {
    ok: false,
    code: error.code,
    message:
      count === 0
        ? error.message
        : count === 1
          ? "One field needs attention."
          : `${count} fields need attention.`,
    byField,
    general,
    values,
  };
}

/** Release 1 has one project, and both configuration actions operate on it. */
async function loadOnlyProject(): Promise<Result<Project>> {
  const projects = await getPlatform().projects.list();
  if (!projects.ok) {
    return projects;
  }
  const project = projects.value[0];
  return project === undefined
    ? err(DeploymentError.of("PROJECT_NOT_FOUND", "No project is registered yet.", { details: {} }))
    : ok(project);
}

/**
 * Mint a project id.
 *
 * Not from `IdGenerator`: that port mints deployment and release ids, which the *engine* needs, and a
 * project is created once by a human at a boundary. Adding a method to a frozen port for a single
 * caller on the outside would widen the domain's contract to serve infrastructure.
 */
function mintProjectId(): string {
  return `prj-${crypto.randomUUID().replaceAll("-", "")}`;
}
