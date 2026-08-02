/**
 * The two conversions between a form and a `Project`.
 *
 * Both directions go through the dotted field names, so neither has a list of fields to keep in step
 * with `form-spec.ts` — add a field there and it is submitted, prefilled, and validated with no other
 * edit. The one thing that is not mechanical is build args, which are a map in the domain and a
 * textarea on screen.
 *
 * Nothing here validates. Coercion produces the shape the domain expects and then lets the domain
 * reject it, because a form that pre-judges its own values will eventually disagree with the rules
 * that actually apply.
 */

import { NEW_PROJECT_DEFAULTS, NUMERIC_FIELDS, PROJECT_FIELD_NAMES } from "./form-spec";

export type FormValues = Readonly<Record<string, string>>;

/* -- Form → domain input ------------------------------------------------- */

export interface ProjectInputFromForm {
  readonly input: Record<string, unknown>;
  /** What was submitted, so a failed attempt is redisplayed with the operator's own values. */
  readonly values: FormValues;
}

/**
 * Rebuild the nested `ProjectInput` from flat form data.
 *
 * `derive` fills the four blank-able fields. It takes the whole value map rather than just the slug
 * so a future default can depend on anything already entered.
 */
export function projectInputFromForm(
  form: FormData,
  options: {
    readonly id: string;
    readonly enabled: boolean;
    /** Forced rather than read from the form on edit, where both are fixed. */
    readonly slug?: string;
    readonly containerName?: string;
  },
): ProjectInputFromForm {
  const submitted: Record<string, string> = {};
  for (const name of PROJECT_FIELD_NAMES) {
    const raw = form.get(name);
    submitted[name] = typeof raw === "string" ? raw.trim() : "";
  }
  if (options.slug !== undefined) {
    submitted.slug = options.slug;
  }
  if (options.containerName !== undefined) {
    submitted["config.containerName"] = options.containerName;
  }

  const filled = { ...submitted, ...derive(submitted) };

  const input: Record<string, unknown> = { id: options.id, enabled: options.enabled };
  for (const name of PROJECT_FIELD_NAMES) {
    assign(input, name, coerce(name, filled[name] ?? ""));
  }

  // Redisplay what they typed, not what was derived from it — a slug that appeared in the box
  // without being typed reads like the form fighting you.
  return { input, values: submitted };
}

/**
 * Fill the fields that can be left blank.
 *
 * The slug comes from the name; the container name and the three references come from the slug.
 * This is why registering a
 * project needs a name, a repository URL, a port, and a host — and nothing else.
 */
function derive(values: Readonly<Record<string, string>>): Record<string, string> {
  const slug = values.slug === "" ? slugify(values.name ?? "") : (values.slug ?? "");
  const derived: Record<string, string> = { slug };

  if (slug === "") {
    // Nothing to derive from. Leave the rest blank and let the domain report the missing name.
    return derived;
  }
  if (values["config.containerName"] === "") {
    // The slug, which is a legal container name by construction — both are DNS-label shaped.
    // A project adopting an application already on the host overrides this with its real name.
    derived["config.containerName"] = slug;
  }
  if (values["config.imageRepository"] === "") {
    derived["config.imageRepository"] = `deployhub/${slug}`;
  }
  if (values["config.gitCredentialRef"] === "") {
    derived["config.gitCredentialRef"] = `${slug}.git.credentials`;
  }
  if (values["config.runtimeEnvRef"] === "") {
    derived["config.runtimeEnvRef"] = `${slug}.runtime.env`;
  }
  return derived;
}

/**
 * A name to a DNS-label-safe slug.
 *
 * Deliberately lossy and deliberately not clever: no transliteration, no unicode folding. Whatever
 * survives is offered to the domain, which has the real rules and will reject what it must — at which
 * point the operator types the slug they wanted. Guessing harder would only move the failure later.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The domain wants integers as integers and build args as a map.
 *
 * An unparseable number is passed through as the string it was, so the domain says "must be an
 * integer" rather than this file inventing a message of its own.
 */
function coerce(name: string, value: string): unknown {
  if (name === "config.buildArgs") {
    return buildArgsFromText(value);
  }
  if (!NUMERIC_FIELDS.has(name)) {
    return value;
  }
  if (value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : value;
}

/**
 * `NAME=value` per line.
 *
 * Only the first `=` splits, so a value may contain them. Blank lines and `#` comments are dropped;
 * a line with no `=` is kept as a name with an empty value so the domain reports it rather than the
 * operator wondering where their typo went.
 */
export function buildArgsFromText(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      entries[trimmed] = "";
      continue;
    }
    entries[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return entries;
}

export function buildArgsToText(entries: Readonly<Record<string, string>>): string {
  return Object.entries(entries)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

/* -- Domain → form values ------------------------------------------------ */

/**
 * Flatten a saved project's JSON onto the form's dotted names.
 *
 * Takes the serialized form rather than the aggregate: the values cross into a Client Component, and
 * only plain data survives that boundary.
 */
export function valuesFromProject(json: Readonly<Record<string, unknown>>): FormValues {
  const values: Record<string, string> = {};
  for (const name of PROJECT_FIELD_NAMES) {
    const found = read(json, name);
    values[name] =
      name === "config.buildArgs"
        ? buildArgsToText(isRecord(found) ? asStrings(found) : {})
        : stringify(found);
  }
  return values;
}

/** A blank form, pre-filled with the defaults that make the common case short. */
export function newProjectValues(): FormValues {
  const values: Record<string, string> = {};
  for (const name of PROJECT_FIELD_NAMES) {
    values[name] = NEW_PROJECT_DEFAULTS[name] ?? "";
  }
  return values;
}

/* -- Dotted-path access -------------------------------------------------- */

function assign(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  const last = segments.pop();
  if (last === undefined) {
    return;
  }
  let cursor = target;
  for (const segment of segments) {
    const existing = cursor[segment];
    if (!isRecord(existing)) {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
      continue;
    }
    cursor = existing as Record<string, unknown>;
  }
  cursor[last] = value;
}

function read(source: Readonly<Record<string, unknown>>, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStrings(record: Readonly<Record<string, unknown>>): Record<string, string> {
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    strings[key] = stringify(value);
  }
  return strings;
}

function stringify(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
