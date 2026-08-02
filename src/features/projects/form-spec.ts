/**
 * The project form, as data.
 *
 * Every field's `name` is the dotted path into `ProjectInput`, which is what lets three separate
 * problems share one solution: the server rebuilds the nested object by splitting names on `.`, the
 * prefill flattens a saved project the same way, and a domain validation issue — which arrives as
 * `config.route.host: …` — lands on the right input without a translation table anyone has to
 * maintain in step with the domain.
 *
 * Grouped rather than listed. Twenty-one inputs in one column is a form nobody reads; seven groups of
 * three is a form you can skim to find the one thing you came to change.
 */

export interface FieldSpec {
  /** Dotted path into `ProjectInput`, and the input's `name`. */
  readonly name: string;
  readonly label: string;
  /** One line under the input. Says what the value is *for*, not what shape it must be. */
  readonly hint?: string;
  readonly kind?: "text" | "number" | "textarea";
  readonly placeholder?: string;
  /**
   * Left blank, the server fills it from the project name. The four of these are the difference
   * between a form with four required fields and a form with eight.
   */
  readonly derived?: boolean;
  /**
   * Editable on `/setup`, read-only afterwards.
   *
   * Only the slug. It is embedded in container names, image repositories, and the workspace path, so
   * changing it does not rename anything — it orphans everything already on the server under the old
   * one. The domain calls the slug stable; this is what makes the UI agree.
   */
  readonly fixedAfterCreate?: boolean;
  /**
   * Extra paths the domain reports this field's problems under.
   *
   * Usually the input path and the issue path are the same word, which is the whole reason the field
   * names are the domain's paths. Two are not: `HealthCheckSpec` *reads* `intervalMillis` and
   * `totalBudgetMillis` but validates them as `interval` and `totalBudget`, because by then they are
   * `Duration` objects rather than numbers of milliseconds. Without these aliases those two messages
   * appear above the form instead of under their input — which is how this list was found.
   */
  readonly issueAliases?: readonly string[];
}

export interface FieldGroup {
  readonly title: string;
  readonly caption: string;
  readonly fields: readonly FieldSpec[];
  /** Two columns for groups of short numeric values; one for anything with long values. */
  readonly columns?: 1 | 2;
}

export const PROJECT_FORM: readonly FieldGroup[] = [
  {
    title: "Project",
    caption: "What this is called, here and on the server.",
    fields: [
      { name: "name", label: "Name", placeholder: "One Community" },
      {
        name: "slug",
        label: "Slug",
        hint: "Used in container names, image tags, and the workspace path. Cannot be changed later.",
        placeholder: "derived from the name",
        derived: true,
        fixedAfterCreate: true,
      },
    ],
  },
  {
    title: "Source",
    caption: "Where the code comes from, and what to deploy by default.",
    fields: [
      {
        name: "config.repositoryUrl",
        label: "Repository URL",
        placeholder: "https://github.com/acme/one-community",
      },
      {
        name: "config.targetRef",
        label: "Default ref",
        hint: "The branch, tag, or commit a deploy uses when you do not name one.",
        placeholder: "main",
      },
      {
        name: "config.gitCredentialRef",
        label: "Git credential",
        hint: "The name of the entry in the secrets file — never the token itself.",
        placeholder: "derived from the slug",
        derived: true,
      },
    ],
  },
  {
    title: "Build",
    caption: "How the image is built. Paths are relative to the repository root.",
    fields: [
      { name: "config.dockerfilePath", label: "Dockerfile", placeholder: "Dockerfile" },
      { name: "config.buildContext", label: "Build context", placeholder: "." },
      {
        name: "config.imageRepository",
        label: "Image repository",
        hint: "Where built images are named. Tags are the commit sha.",
        placeholder: "derived from the slug",
        derived: true,
      },
      {
        name: "config.buildArgs",
        label: "Build args",
        kind: "textarea",
        hint: "One NAME=value per line. These persist in image history forever, so never put a secret here.",
        placeholder: "NODE_ENV=production",
      },
    ],
  },
  {
    title: "Runtime",
    caption: "How the container runs.",
    columns: 2,
    fields: [
      {
        name: "config.containerPort",
        label: "Container port",
        kind: "number",
        hint: "The port the application listens on inside the container.",
        placeholder: "3000",
      },
      {
        name: "config.runtimeEnvRef",
        label: "Environment",
        hint: "The secrets-file entry holding the container's environment variables.",
        placeholder: "derived from the slug",
        derived: true,
      },
    ],
  },
  {
    title: "Route",
    caption: "The address people reach the application at.",
    columns: 2,
    fields: [
      { name: "config.route.host", label: "Host", placeholder: "app.example.com" },
      {
        name: "config.route.path",
        label: "Path",
        hint: "Use / when the whole host serves this application.",
        placeholder: "/",
      },
    ],
  },
  {
    title: "Health check",
    caption:
      "What healthy means. DeployHub probes the new container here after starting it, and puts the previous release back if it never passes.",
    columns: 2,
    fields: [
      { name: "config.healthCheck.path", label: "Path", placeholder: "/healthz" },
      {
        name: "config.healthCheck.expectedStatus",
        label: "Expected status",
        kind: "number",
        placeholder: "200",
      },
      {
        name: "config.healthCheck.intervalMillis",
        label: "Interval (ms)",
        kind: "number",
        placeholder: "1000",
        issueAliases: ["config.healthCheck.interval"],
      },
      {
        name: "config.healthCheck.requiredConsecutivePasses",
        label: "Consecutive passes",
        kind: "number",
        hint: "Above one, a service that flaps pass/fail/pass is never accepted as healthy.",
        placeholder: "2",
      },
      {
        name: "config.healthCheck.totalBudgetMillis",
        label: "Total budget (ms)",
        kind: "number",
        hint: "How long the new container has to become healthy before the deployment rolls back.",
        placeholder: "60000",
        issueAliases: ["config.healthCheck.totalBudget"],
      },
    ],
  },
  {
    title: "Retention",
    caption: "How much history stays on the host.",
    columns: 2,
    fields: [
      {
        name: "config.imageRetention",
        label: "Images to keep",
        kind: "number",
        hint: "At least two: rollback needs the previous image to still be on the host.",
        placeholder: "3",
      },
    ],
  },
];

/** Every field name, in form order. */
export const PROJECT_FIELD_NAMES: readonly string[] = PROJECT_FORM.flatMap((group) =>
  group.fields.map((field) => field.name),
);

/** Issue path → the field it belongs to. Every field's own name, plus its aliases. */
export const PROJECT_ISSUE_PATHS: Readonly<Record<string, string>> = Object.fromEntries(
  PROJECT_FORM.flatMap((group) =>
    group.fields.flatMap((field) =>
      [field.name, ...(field.issueAliases ?? [])].map((path) => [path, field.name] as const),
    ),
  ),
);

/** Fields the domain requires as integers rather than strings. */
export const NUMERIC_FIELDS: ReadonlySet<string> = new Set(
  PROJECT_FORM.flatMap((group) =>
    group.fields.filter((field) => field.kind === "number").map((field) => field.name),
  ),
);

/** Defaults for a new project, so the shortest useful form is four fields long. */
export const NEW_PROJECT_DEFAULTS: Readonly<Record<string, string>> = {
  "config.targetRef": "main",
  "config.dockerfilePath": "Dockerfile",
  "config.buildContext": ".",
  "config.route.path": "/",
  "config.healthCheck.path": "/",
  "config.healthCheck.expectedStatus": "200",
  "config.healthCheck.intervalMillis": "1000",
  "config.healthCheck.requiredConsecutivePasses": "2",
  "config.healthCheck.totalBudgetMillis": "60000",
  "config.imageRetention": "3",
};
