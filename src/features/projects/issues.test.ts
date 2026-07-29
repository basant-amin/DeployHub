// @vitest-environment node
import { describe, expect, it } from "vitest";

import { Project } from "@/core/domain";

import { PROJECT_FIELD_NAMES, PROJECT_ISSUE_PATHS } from "./form-spec";
import { newProjectValues, projectInputFromForm } from "./form-values";
import { attributeIssues, fieldMessage } from "./issues";

const attribute = (issues: readonly string[]) => attributeIssues(issues, PROJECT_ISSUE_PATHS);

/** A submission that is valid apart from whatever the caller overrides. */
function submission(overrides: Readonly<Record<string, string>>): FormData {
  const values: Record<string, string> = {
    ...newProjectValues(),
    name: "One Community",
    "config.repositoryUrl": "https://github.com/acme/one-community",
    "config.containerPort": "3000",
    "config.route.host": "app.example.com",
    ...overrides,
  };
  const form = new FormData();
  for (const [name, value] of Object.entries(values)) {
    form.set(name, value);
  }
  return form;
}

describe("attributeIssues", () => {
  it("puts a top-level field's issue on that field", () => {
    const { byField, general } = attribute(["slug: must be at least 2 characters"]);
    expect(byField.slug).toEqual(["must be at least 2 characters"]);
    expect(general).toEqual([]);
  });

  it("follows a nested path to the input that owns it", () => {
    const { byField } = attribute([
      "config.route.host: Hostname must be a valid DNS name",
      "config.healthCheck.expectedStatus: Expected status must be at least 100",
    ]);
    expect(byField["config.route.host"]).toEqual(["Hostname must be a valid DNS name"]);
    expect(byField["config.healthCheck.expectedStatus"]).toEqual([
      "Expected status must be at least 100",
    ]);
  });

  it("reports every bad field at once, which is the whole point of combineFields", () => {
    const { byField } = attribute([
      "name: must be at least 2 characters",
      "config.repositoryUrl: must be an https or ssh URL",
      "config.containerPort: must be an integer",
    ]);
    expect(Object.keys(byField)).toHaveLength(3);
  });

  it("keeps several issues for one field, in the order reported", () => {
    const { byField } = attribute([
      "config.containerPort: must be an integer",
      "config.containerPort: must be at most 65535",
    ]);
    expect(byField["config.containerPort"]).toEqual([
      "must be an integer",
      "must be at most 65535",
    ]);
  });

  it("does not split on a colon inside the message", () => {
    // Splitting on the first ": " would invent a field called
    // `config.buildArgs."FOO-BAR" is not a valid build arg name`.
    const inner = '"FOO-BAR" is not a valid build arg name: use letters, digits, and underscores';
    const { byField, general } = attribute([`config.buildArgs.${inner}`]);
    expect(byField["config.buildArgs"]).toEqual([inner]);
    expect(general).toEqual([]);
  });

  it("prefers the longest matching field name", () => {
    // `config.route.path` must not be attributed to a shorter prefix.
    const { byField } = attribute(["config.route.path: must start with /"]);
    expect(byField["config.route.path"]).toEqual(["must start with /"]);
    expect(byField["config.route"]).toBeUndefined();
  });

  it("surfaces an issue that matches no field instead of dropping it", () => {
    const { byField, general } = attribute(["enabled: must be a boolean"]);
    expect(byField).toEqual({});
    expect(general).toEqual(["enabled: must be a boolean"]);
  });

  it("keeps the whole issue when a field name arrives with no message after it", () => {
    const { byField } = attribute(["slug"]);
    expect(byField.slug).toEqual(["slug"]);
  });

  it("follows an alias to the input that carries the value", () => {
    // HealthCheckSpec reads `intervalMillis` and validates `interval`, because by then it is a
    // Duration. Without the alias this message appeared above the form instead of under its input.
    const { byField, general } = attribute([
      "config.healthCheck.interval: Health check interval in milliseconds must be at least 100",
      "config.healthCheck.totalBudget: must be at most 1800000",
    ]);
    expect(byField["config.healthCheck.intervalMillis"]).toEqual([
      "Health check interval in milliseconds must be at least 100",
    ]);
    expect(byField["config.healthCheck.totalBudgetMillis"]).toEqual(["must be at most 1800000"]);
    expect(general).toEqual([]);
  });

  it("attributes a cross-field rule to the field it opens with", () => {
    // The health check's impossible-budget rule names its subject first, separated by a space
    // rather than a colon.
    const issue =
      "config.healthCheck.totalBudgetMillis (500) is shorter than intervalMillis (1000)";
    const { byField } = attribute([issue]);
    expect(byField["config.healthCheck.totalBudgetMillis"]).toEqual([
      "(500) is shorter than intervalMillis (1000)",
    ]);
  });

  it("will not let a path claim a longer name that merely starts with it", () => {
    const { byField, general } = attribute(["config.healthCheck.pathological: nonsense"]);
    expect(byField).toEqual({});
    expect(general).toEqual(["config.healthCheck.pathological: nonsense"]);
  });
});

/**
 * The mapping, checked against the real domain rather than against strings I typed.
 *
 * Every field gets one genuinely invalid value, `Project.create` is asked what it thinks, and the
 * resulting issue must land on that field. This is what turns "the form names are the domain's paths"
 * from a claim into something that fails a build when it stops being true — a renamed key or a new
 * required field breaks a test instead of quietly pushing a message into the general bucket.
 */
describe("attribution against the domain", () => {
  const INVALID: Readonly<Record<string, string>> = {
    name: "A",
    slug: "-nope-",
    "config.repositoryUrl": "not a url",
    "config.targetRef": "bad~ref",
    "config.gitCredentialRef": "Bad Ref!",
    "config.dockerfilePath": "/absolute/Dockerfile",
    "config.buildContext": "../escape",
    "config.imageRepository": "BAD CAPS",
    "config.buildArgs": "BAD-NAME=1",
    "config.containerPort": "0",
    "config.runtimeEnvRef": "Bad Ref!",
    "config.route.host": "not a host!",
    "config.route.path": "no-leading-slash",
    "config.healthCheck.path": "no-leading-slash",
    "config.healthCheck.expectedStatus": "99",
    "config.healthCheck.intervalMillis": "50",
    "config.healthCheck.requiredConsecutivePasses": "0",
    "config.healthCheck.totalBudgetMillis": "1",
    "config.imageRetention": "1",
  };

  it("covers every field in the form", () => {
    // If a field is added without an invalid example, the loop below would silently skip it.
    expect(Object.keys(INVALID).sort()).toEqual([...PROJECT_FIELD_NAMES].sort());
  });

  for (const [field, value] of Object.entries(INVALID)) {
    it(`attributes ${field} to its own input`, () => {
      const result = Project.create(
        projectInputFromForm(submission({ [field]: value }), {
          id: "prj-0000000000000001",
          enabled: true,
        }).input,
      );

      expect(result.ok, `${field}="${value}" was accepted; pick a value the domain rejects`).toBe(
        false,
      );
      if (result.ok) {
        return;
      }

      const { byField, general } = attribute(result.error.issues);

      // Nothing may be unattributed, and this field must be one of the inputs marked.
      expect(general, `unattributed issues for ${field}`).toEqual([]);
      expect(Object.keys(byField)).toContain(field);
    });
  }
});

describe("fieldMessage", () => {
  it("completes a sentence fragment with its label", () => {
    expect(fieldMessage("Slug", "must be at least 2 characters")).toBe(
      "Slug must be at least 2 characters",
    );
  });

  it("leaves a message that already stands on its own", () => {
    expect(fieldMessage("Build args", '"FOO-BAR" is not a valid name')).toBe(
      '"FOO-BAR" is not a valid name',
    );
  });
});
