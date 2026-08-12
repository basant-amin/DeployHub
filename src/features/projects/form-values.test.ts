// @vitest-environment node
import { describe, expect, it } from "vitest";

import { Project } from "@/core/domain";
import { expectOk } from "@/core/shared/result.testing";

import { PROJECT_FIELD_NAMES } from "./form-spec";
import {
  buildArgsFromText,
  buildArgsToText,
  newProjectValues,
  projectInputFromForm,
  slugify,
  valuesFromProject,
} from "./form-values";

/** A complete, valid submission, as the browser would send it. */
function submission(overrides: Readonly<Record<string, string>> = {}): FormData {
  const values: Record<string, string> = {
    ...newProjectValues(),
    name: "One Community",
    "config.repositoryUrl": "https://github.com/acme/one-community",
    // An HTTPS clone URL, so the method has to be the one that authenticates over HTTPS. The
    // form's own default is `ssh-deploy-key`, which pairs with an SSH URL — the two are checked
    // against each other by the domain, so a fixture cannot leave them contradicting.
    "config.gitAuth.method": "https-token",
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

describe("slugify", () => {
  it("turns a name into a DNS label", () => {
    expect(slugify("One Community")).toBe("one-community");
    expect(slugify("  Acme:  Widgets!  ")).toBe("acme-widgets");
  });

  it("has no hyphen at either end, which the domain rejects", () => {
    expect(slugify("!!! Hello !!!")).toBe("hello");
  });

  it("gives up rather than guessing when nothing survives", () => {
    // The operator then types the slug they want, and the domain reports the blank one meanwhile.
    expect(slugify("日本語")).toBe("");
  });
});

describe("buildArgsFromText", () => {
  it("splits on the first equals only, so a value may contain them", () => {
    expect(buildArgsFromText("DSN=postgres://u:p@h/db?a=1")).toEqual({
      DSN: "postgres://u:p@h/db?a=1",
    });
  });

  it("ignores blank lines and comments", () => {
    expect(buildArgsFromText("A=1\n\n# a note\nB=2\n")).toEqual({ A: "1", B: "2" });
  });

  it("keeps a line with no equals so the domain reports the typo", () => {
    // Dropping it silently would leave the operator hunting for a build arg that never arrived.
    expect(buildArgsFromText("NOT_AN_ASSIGNMENT")).toEqual({ NOT_AN_ASSIGNMENT: "" });
  });

  it("round-trips through the textarea representation", () => {
    const entries = { NODE_ENV: "production", API_BASE: "https://api.example.com" };
    expect(buildArgsFromText(buildArgsToText(entries))).toEqual(entries);
  });
});

describe("projectInputFromForm", () => {
  it("accepts a four-field submission by deriving the rest", () => {
    const { input } = projectInputFromForm(submission(), {
      id: "prj-0000000000000001",
      enabled: true,
    });
    const project = expectOk(Project.create(input));

    expect(project.slug).toBe("one-community");
    expect(project.config.imageRepository).toBe("deployhub/one-community");
    expect(project.config.gitCredentialRef).toBe("one-community.git.credentials");
    expect(project.config.runtimeEnvRef).toBe("one-community.runtime.env");
    expect(project.config.containerName).toBe("one-community");
  });

  it("takes the container name from the form when the host already runs one", () => {
    // Adopting an existing deployment: the container is called what it is called, and the
    // platform has to use that name rather than the one it would have chosen.
    const { input } = projectInputFromForm(
      submission({ "config.containerName": "legacy-app-prod" }),
      { id: "prj-0000000000000001", enabled: true },
    );
    const project = expectOk(Project.create(input));

    expect(project.config.containerName).toBe("legacy-app-prod");
    // Everything else still derives from the slug — the override is scoped to the one field.
    expect(project.slug).toBe("one-community");
    expect(project.config.imageRepository).toBe("deployhub/one-community");
  });

  it("prefers what was typed over what would be derived", () => {
    const { input } = projectInputFromForm(
      submission({ slug: "oc-prod", "config.imageRepository": "registry.acme.com/oc" }),
      { id: "prj-0000000000000001", enabled: true },
    );
    const project = expectOk(Project.create(input));

    expect(project.slug).toBe("oc-prod");
    expect(project.config.imageRepository).toBe("registry.acme.com/oc");
    // The references still derive from the slug that was actually used.
    expect(project.config.gitCredentialRef).toBe("oc-prod.git.credentials");
  });

  it("coerces the integer fields, which the domain refuses as strings", () => {
    const { input } = projectInputFromForm(submission(), {
      id: "prj-0000000000000001",
      enabled: true,
    });
    const project = expectOk(Project.create(input));

    expect(project.config.containerPort).toBe(3000);
    expect(project.config.healthCheck.expectedStatus).toBe(200);
    expect(project.config.imageRetention).toBe(3);
  });

  it("passes an unparseable number through, so the domain writes the message", () => {
    const { input } = projectInputFromForm(submission({ "config.containerPort": "eighty" }), {
      id: "prj-0000000000000001",
      enabled: true,
    });
    const result = Project.create(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.join(" ")).toContain("containerPort");
    }
  });

  it("forces the slug on edit, whatever the form says", () => {
    // The slug is embedded in container names and the workspace path; the read-only input is a
    // courtesy and this is the half that holds.
    const { input } = projectInputFromForm(submission({ slug: "renamed" }), {
      id: "prj-0000000000000001",
      enabled: false,
      slug: "original",
    });
    const project = expectOk(Project.create(input));

    expect(project.slug).toBe("original");
    expect(project.enabled).toBe(false);
  });

  it("returns the submitted values rather than the derived ones", () => {
    // A slug appearing in the box without being typed reads as the form fighting the operator.
    const { values } = projectInputFromForm(submission(), {
      id: "prj-0000000000000001",
      enabled: true,
    });
    expect(values.slug).toBe("");
    expect(values.name).toBe("One Community");
  });

  it("trims, because a trailing space in a hostname is invisible and fatal", () => {
    const { input } = projectInputFromForm(
      submission({ "config.route.host": "  app.example.com  " }),
      {
        id: "prj-0000000000000001",
        enabled: true,
      },
    );
    expect(expectOk(Project.create(input)).config.route.host).toBe("app.example.com");
  });
});

describe("valuesFromProject", () => {
  it("round-trips a saved project back through the form unchanged", () => {
    const original = expectOk(
      Project.create(
        projectInputFromForm(submission(), { id: "prj-0000000000000001", enabled: true }).input,
      ),
    );

    const values = valuesFromProject(original.toJSON());
    const form = new FormData();
    for (const [name, value] of Object.entries(values)) {
      form.set(name, value);
    }
    const reloaded = expectOk(
      Project.create(
        projectInputFromForm(form, { id: "prj-0000000000000001", enabled: true }).input,
      ),
    );

    expect(reloaded.toJSON()).toEqual(original.toJSON());
  });

  it("fills every field the form knows about", () => {
    const project = expectOk(
      Project.create(
        projectInputFromForm(submission(), { id: "prj-0000000000000001", enabled: true }).input,
      ),
    );
    const values = valuesFromProject(project.toJSON());

    // Two fields are legitimately empty; everything else must have a value, or an input would
    // render blank and quietly clear a configured setting on the next save. `knownHostsRef` is the
    // interesting one: blank *is* its configured value — it means "verify github.com against the
    // bundled host keys" — so round-tripping it as blank loses nothing.
    const mayBeBlank = new Set(["config.buildArgs", "config.gitAuth.knownHostsRef"]);

    for (const name of PROJECT_FIELD_NAMES) {
      if (mayBeBlank.has(name)) {
        continue;
      }
      expect(values[name], name).not.toBe("");
    }
  });

  it("renders build args as editable lines", () => {
    const project = expectOk(
      Project.create(
        projectInputFromForm(submission({ "config.buildArgs": "NODE_ENV=production" }), {
          id: "prj-0000000000000001",
          enabled: true,
        }).input,
      ),
    );
    expect(valuesFromProject(project.toJSON())["config.buildArgs"]).toBe("NODE_ENV=production");
  });
});
