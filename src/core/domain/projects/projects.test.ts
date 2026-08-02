// @vitest-environment node
import { describe, expect, it } from "vitest";

import { expectErr, expectOk } from "@/core/shared/result.testing";

import { BuildArgs } from "./build-args";
import { DeployConfig } from "./deploy-config";
import { HealthCheckSpec } from "./health-check-spec";
import { ImageRetention, MINIMUM_IMAGE_RETENTION } from "./image-retention";
import { Project } from "./project";
import { ProjectName, ProjectSlug } from "./project-name";
import { PublicRoute } from "./public-route";

const validConfig = Object.freeze({
  repositoryUrl: "git@github.com:elemta/one-community.git",
  gitCredentialRef: "one-community.git.credentials",
  targetRef: "main",
  dockerfilePath: "Dockerfile",
  buildContext: ".",
  buildArgs: { NODE_ENV: "production" },
  runtimeEnvRef: "one-community.runtime.env",
  containerName: "one-community",
  containerPort: 3000,
  route: { host: "app.onecommunity.example", path: "/" },
  healthCheck: {
    path: "/healthz",
    expectedStatus: 200,
    intervalMillis: 1000,
    requiredConsecutivePasses: 3,
    totalBudgetMillis: 60_000,
  },
  imageRepository: "deployhub/one-community",
  imageRetention: 5,
});

const validProject = Object.freeze({
  id: "prj-one-community",
  name: "One Community",
  slug: "one-community",
  config: validConfig,
});

describe("ProjectName and ProjectSlug", () => {
  it("accepts a display name and rejects control characters", () => {
    expect(ProjectName.parse("One Community").ok).toBe(true);
    expect(ProjectName.parse("One\nCommunity").ok).toBe(false);
    expect(ProjectName.parse("x").ok).toBe(false);
  });

  it("constrains the slug to what containers, images, and DNS all accept", () => {
    expect(ProjectSlug.parse("one-community").ok).toBe(true);
    expect(expectOk(ProjectSlug.parse("One-Community"))).toBe("one-community");
    // Consecutive hyphens are legal in a DNS label, so the slug permits them.
    expect(ProjectSlug.parse("double--hyphen").ok).toBe(true);
    expect(ProjectSlug.parse("-leading").ok).toBe(false);
    expect(ProjectSlug.parse("trailing-").ok).toBe(false);
    expect(ProjectSlug.parse("under_score").ok).toBe(false);
    expect(ProjectSlug.parse("a".repeat(64)).ok).toBe(false);
  });
});

describe("PublicRoute", () => {
  it("defaults to the host root", () => {
    const route = expectOk(PublicRoute.create({ host: "app.example.com" }));
    expect(route.path).toBe("/");
    expect(route.isHostRoot).toBe(true);
    expect(route.toString()).toBe("app.example.com");
  });

  it("keeps a subpath and renders it", () => {
    const route = expectOk(PublicRoute.create({ host: "example.com", path: "/community" }));
    expect(route.isHostRoot).toBe(false);
    expect(route.toString()).toBe("example.com/community");
  });

  it("reports both bad halves at once", () => {
    expect(
      expectErr(PublicRoute.create({ host: "bad host", path: "relative" })).issues,
    ).toHaveLength(2);
  });

  it("rejects a shape that is not an object at all", () => {
    expect(expectErr(PublicRoute.create("app.example.com")).message).toContain("must be an object");
    expect(PublicRoute.create(undefined).ok).toBe(false);
  });
});

describe("HealthCheckSpec", () => {
  const valid = validConfig.healthCheck;

  it("accepts a workable spec", () => {
    const spec = expectOk(HealthCheckSpec.create(valid));
    expect(spec.requiredConsecutivePasses).toBe(3);
    expect(spec.accepts(200)).toBe(true);
    expect(spec.accepts(503)).toBe(false);
    // Three passes at a 1s interval: the first probe is immediate, so 2s.
    expect(spec.minimumTimeToPass.millis).toBe(2000);
  });

  it("computes no minimum wait for a single required pass", () => {
    const spec = expectOk(HealthCheckSpec.create({ ...valid, requiredConsecutivePasses: 1 }));
    expect(spec.minimumTimeToPass.millis).toBe(0);
  });

  it("rejects a spec that can never pass", () => {
    const error = expectErr(
      HealthCheckSpec.create({
        ...valid,
        intervalMillis: 10_000,
        requiredConsecutivePasses: 10,
        totalBudgetMillis: 5_000,
      }),
    );
    expect(error.issues.join(" ")).toContain("can never pass");
  });

  it("bounds each field", () => {
    expect(HealthCheckSpec.create({ ...valid, expectedStatus: 99 }).ok).toBe(false);
    expect(HealthCheckSpec.create({ ...valid, expectedStatus: 600 }).ok).toBe(false);
    expect(HealthCheckSpec.create({ ...valid, intervalMillis: 10 }).ok).toBe(false);
    expect(HealthCheckSpec.create({ ...valid, requiredConsecutivePasses: 0 }).ok).toBe(false);
    expect(HealthCheckSpec.create({ ...valid, totalBudgetMillis: 100 }).ok).toBe(false);
    expect(HealthCheckSpec.create({ ...valid, path: "healthz" }).ok).toBe(false);
    expect(HealthCheckSpec.create("not an object").ok).toBe(false);
  });

  it("round-trips through JSON", () => {
    const spec = expectOk(HealthCheckSpec.create(valid));
    expect(expectOk(HealthCheckSpec.create(spec.toJSON())).equals(spec)).toBe(true);
  });
});

describe("BuildArgs", () => {
  it("defaults to empty", () => {
    expect(expectOk(BuildArgs.create(undefined)).isEmpty).toBe(true);
    expect(expectOk(BuildArgs.create(null)).isEmpty).toBe(true);
    expect(expectOk(BuildArgs.create({})).size).toBe(0);
  });

  it("keeps ordinary build arguments", () => {
    const args = expectOk(BuildArgs.create({ NODE_ENV: "production", PORT: "3000" }));
    expect(args.size).toBe(2);
    expect(args.get("NODE_ENV")).toBe("production");
    expect(args.get("MISSING")).toBeUndefined();
    expect(args.toJSON()).toEqual({ NODE_ENV: "production", PORT: "3000" });
  });

  it("accepts a name that merely resembles a credential", () => {
    // Screening names for secret-looking words is platform policy, not a domain
    // invariant, and it has no override for a legitimate case like this one.
    expect(BuildArgs.create({ TOKEN_BUDGET: "4096" }).ok).toBe(true);
    expect(BuildArgs.create({ PUBLIC_KEY_URL: "https://example.com/k" }).ok).toBe(true);
  });

  it("rejects malformed names and non-string values together", () => {
    expect(expectErr(BuildArgs.create({ "1BAD": "x", GOOD: 42 })).issues).toHaveLength(2);
  });

  it("rejects a value that is not an object", () => {
    expect(BuildArgs.create("NODE_ENV=production").ok).toBe(false);
  });
});

describe("ImageRetention", () => {
  it("requires room for the live image and the previous one", () => {
    expect(ImageRetention.parse(1).ok).toBe(false);
    expect(ImageRetention.parse(MINIMUM_IMAGE_RETENTION).ok).toBe(true);
    expect(ImageRetention.parse(51).ok).toBe(false);
  });
});

describe("DeployConfig", () => {
  it("accepts a complete configuration", () => {
    const config = expectOk(DeployConfig.create(validConfig));
    expect(config.targetRef).toBe("main");
    expect(config.containerPort).toBe(3000);
    expect(config.route.host).toBe("app.onecommunity.example");
    expect(config.healthCheck.requiredConsecutivePasses).toBe(3);
  });

  it("reports every invalid field in one failure", () => {
    const error = expectErr(
      DeployConfig.create({
        ...validConfig,
        repositoryUrl: "nope",
        containerPort: 0,
        imageRetention: 1,
      }),
    );
    expect(error.code).toBe("DEPLOY_CONFIG_INVALID");
    expect(error.issues).toHaveLength(3);
  });

  it("surfaces a nested failure with a readable path", () => {
    const error = expectErr(
      DeployConfig.create({
        ...validConfig,
        healthCheck: { ...validConfig.healthCheck, path: "healthz" },
      }),
    );
    expect(error.issues.join(" ")).toContain("healthCheck.path");
  });

  it("accepts a Dockerfile outside its build context, which docker permits", () => {
    // `docker build -f ../Dockerfile ctx` is legal. Rejecting it would be enforcing a
    // convention as an invariant and would refuse a working configuration.
    expect(
      DeployConfig.create({
        ...validConfig,
        buildContext: "apps/web",
        dockerfilePath: "Dockerfile",
      }).ok,
    ).toBe(true);
  });

  it("accepts one secret reference used for both credentials and runtime env", () => {
    // A project may legitimately keep both in one bundle; the domain does not decide
    // how an operator organizes their secret store.
    expect(
      DeployConfig.create({ ...validConfig, runtimeEnvRef: validConfig.gitCredentialRef }).ok,
    ).toBe(true);
  });

  it("holds secret references, never secret values", () => {
    const serialized = JSON.stringify(expectOk(DeployConfig.create(validConfig)).toJSON());
    expect(serialized).toContain("one-community.git.credentials");
    expect(serialized).not.toContain("password");
  });

  it("rejects a config that is not an object", () => {
    expect(DeployConfig.create(null).ok).toBe(false);
  });
});

describe("Project", () => {
  it("is enabled by default", () => {
    const project = expectOk(Project.create(validProject));
    expect(project.enabled).toBe(true);
    expect(project.isDeployable).toBe(true);
    expect(project.ensureDeployable().ok).toBe(true);
  });

  it("refuses deployment when disabled, as a precondition rather than bad input", () => {
    const project = expectOk(Project.create({ ...validProject, enabled: false }));
    expect(project.isDeployable).toBe(false);
    const error = expectErr(project.ensureDeployable());
    expect(error.code).toBe("PROJECT_DISABLED");
    expect(error.errorClass).toBe("PRECONDITION");
  });

  it("toggles immutably, keeping identity", () => {
    const project = expectOk(Project.create(validProject));
    const disabled = project.disable();
    expect(disabled).not.toBe(project);
    expect(project.enabled).toBe(true);
    expect(disabled.enable().enabled).toBe(true);
    expect(disabled.equals(project)).toBe(true);
    // Idempotent: disabling twice is the same object, not a new one.
    expect(disabled.disable()).toBe(disabled);
    expect(project.enable()).toBe(project);
  });

  it("rejects a bad id, name, slug, and config together", () => {
    const error = expectErr(Project.create({ id: "x", name: "y", slug: "-bad-", config: {} }));
    expect(error.issues.length).toBeGreaterThanOrEqual(4);
  });

  it("rejects a non-boolean enabled flag", () => {
    expect(Project.create({ ...validProject, enabled: "yes" }).ok).toBe(false);
  });

  it("serializes with its config", () => {
    const json = expectOk(Project.create(validProject)).toJSON();
    expect(json.slug).toBe("one-community");
    expect(json.enabled).toBe(true);
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});
