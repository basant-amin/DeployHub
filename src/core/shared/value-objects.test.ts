// @vitest-environment node
import { describe, expect, it } from "vitest";

import { Actor, IdempotencyKey } from "./actor";
import { ContainerId, ContainerName, ContainerPort } from "./container";
import { CommitSha, GitRef, GitRepositoryUrl } from "./git";
import { DeploymentId, ProjectId, ReleaseId } from "./ids";
import { ImageDigest, ImageReference, ImageRepository, ImageTag } from "./image";
import { LockEpoch } from "./lock-epoch";
import { Hostname } from "./network";
import { RelativePath, UrlPath } from "./path";
import { expectErr, expectOk } from "./result.testing";
import { SecretRef } from "./secret-ref";

describe("identifiers", () => {
  it("accept the shapes ULID, UUID, and nanoid all produce", () => {
    for (const id of ["prj-one-community", "01JBQ8YV3K7T9WZ6M4N2P5R8QD", "dep_00000001"]) {
      expect(ProjectId.parse(id).ok, id).toBe(true);
    }
    for (const id of ["short", "", "has space", "-leading"]) {
      expect(ProjectId.parse(id).ok, id).toBe(false);
    }
  });

  it("are distinct types over the same shape", () => {
    expect(DeploymentId.parse("dep-00000001").ok).toBe(true);
    expect(ReleaseId.parse("rel-00000001").ok).toBe(true);
  });
});

describe("git", () => {
  it("requires a full commit sha and normalizes its case", () => {
    expect(expectOk(CommitSha.parse("A".repeat(40)))).toBe("a".repeat(40));
    expect(CommitSha.parse("a".repeat(7)).ok).toBe(false);
    expect(CommitSha.parse("z".repeat(40)).ok).toBe(false);
  });

  it("accepts real refs and rejects git's revision operators", () => {
    for (const ref of ["main", "release/2026-07", "feature-x", "v1.2.3", "hotfix_1", "a.b.c"]) {
      expect(GitRef.parse(ref).ok, ref).toBe(true);
    }
    for (const ref of [
      "main~1",
      "main^",
      "a..b",
      "with space",
      "trailing/",
      "/leading",
      "ends.",
      "@",
      "x.lock",
      "double//slash",
      "brace@{1}",
    ]) {
      expect(GitRef.parse(ref).ok, ref).toBe(false);
    }
  });

  it("accepts https, ssh, and scp-style repository URLs", () => {
    for (const url of [
      "https://github.com/elemta/one-community.git",
      "git@github.com:elemta/one-community.git",
      "ssh://git@github.com/elemta/one-community.git",
    ]) {
      expect(GitRepositoryUrl.parse(url).ok, url).toBe(true);
    }
    for (const url of ["http://insecure.example/repo.git", "just-a-name", "ftp://x/y"]) {
      expect(GitRepositoryUrl.parse(url).ok, url).toBe(false);
    }
  });
});

describe("container handles", () => {
  it("bounds ports to the TCP range", () => {
    expect(ContainerPort.parse(0).ok).toBe(false);
    expect(ContainerPort.parse(65_536).ok).toBe(false);
    expect(ContainerPort.parse(3000).ok).toBe(true);
    expect(ContainerPort.parse(3000.5).ok).toBe(false);
  });

  it("accepts runtime ids and names the runtime will accept", () => {
    expect(ContainerId.parse("a".repeat(12)).ok).toBe(true);
    expect(ContainerId.parse("a".repeat(64)).ok).toBe(true);
    expect(ContainerId.parse("a".repeat(11)).ok).toBe(false);
    expect(ContainerId.parse("g".repeat(12)).ok).toBe(false);
    expect(ContainerName.parse("one-community").ok).toBe(true);
    expect(ContainerName.parse("one-community-candidate-dep-1").ok).toBe(true);
    expect(ContainerName.parse("-leading-hyphen").ok).toBe(false);
  });
});

describe("images", () => {
  it("requires a digest to be a content address", () => {
    expect(ImageDigest.parse(`sha256:${"a".repeat(64)}`).ok).toBe(true);
    expect(ImageDigest.parse(`sha256:${"a".repeat(63)}`).ok).toBe(false);
    expect(ImageDigest.parse("latest").ok).toBe(false);
  });

  it("splits a reference into repository and tag", () => {
    const reference = expectOk(ImageReference.parse("deployhub/one-community:abc123"));
    expect(reference.repository).toBe("deployhub/one-community");
    expect(reference.tag).toBe("abc123");
    expect(reference.toString()).toBe("deployhub/one-community:abc123");
  });

  it("rejects a reference with no tag, an empty tag, or a bad repository", () => {
    for (const raw of ["deployhub/one-community", "deployhub/one-community:", ":abc", "a b:tag"]) {
      expect(ImageReference.parse(raw).ok, raw).toBe(false);
    }
  });

  it("normalizes repository case rather than rejecting it", () => {
    // Container runtimes require a lowercase repository. Normalizing is friendlier
    // than refusing, and it cannot change which image is meant — the same rule the
    // hostname and slug codecs follow. Tags stay case-sensitive, because they are.
    expect(expectOk(ImageRepository.parse("Deployhub/One"))).toBe("deployhub/one");
    expect(expectOk(ImageReference.parse("Deployhub/One:AbC")).toString()).toBe(
      "deployhub/one:AbC",
    );
    expect(expectOk(ImageTag.parse("AbC"))).toBe("AbC");
  });

  it("validates the halves independently", () => {
    expect(ImageRepository.parse("deployhub/one-community").ok).toBe(true);
    expect(ImageRepository.parse("double//slash").ok).toBe(false);
    expect(ImageTag.parse("a1b2c3").ok).toBe(true);
    expect(ImageTag.parse("-leading").ok).toBe(false);
  });
});

describe("paths", () => {
  it("rejects traversal and absolute paths", () => {
    for (const path of ["apps/web/Dockerfile", ".", "Dockerfile"]) {
      expect(RelativePath.parse(path).ok, path).toBe(true);
    }
    for (const path of ["/etc/passwd", "../../secrets", "apps//web", "apps/./web", "a\\b"]) {
      expect(RelativePath.parse(path).ok, path).toBe(false);
    }
  });

  it("requires a URL path to be absolute and traversal-free", () => {
    expect(UrlPath.parse("/healthz").ok).toBe(true);
    expect(UrlPath.parse("/api/health?deep=1").ok).toBe(true);
    expect(UrlPath.parse("healthz").ok).toBe(false);
    expect(UrlPath.parse("/../admin").ok).toBe(false);
  });
});

describe("references, actors, hosts, and epochs", () => {
  it("accepts a dotted secret reference and nothing resembling a value", () => {
    expect(SecretRef.parse("one-community.git.credentials").ok).toBe(true);
    expect(SecretRef.parse("Has-Uppercase").ok).toBe(false);
    expect(SecretRef.parse("a").ok).toBe(false);
  });

  it("records an actor without line breaks", () => {
    expect(Actor.parse("basant@elemta.com").ok).toBe(true);
    expect(Actor.parse("with\nnewline").ok).toBe(false);
    expect(expectErr(Actor.parse("x")).code).toBe("ACTOR_INVALID");
  });

  it("requires an idempotency key long enough to be unique per click", () => {
    expect(IdempotencyKey.parse("click-0000000001").ok).toBe(true);
    expect(IdempotencyKey.parse("tiny").ok).toBe(false);
  });

  it("accepts hostnames and loopback addresses", () => {
    for (const host of ["app.example.com", "localhost", "127.0.0.1", "my-host"]) {
      expect(Hostname.parse(host).ok, host).toBe(true);
    }
    expect(Hostname.parse("bad host").ok).toBe(false);
    expect(Hostname.parse("-leading.example").ok).toBe(false);
  });

  it("requires a lock epoch to start at one", () => {
    expect(LockEpoch.parse(0).ok).toBe(false);
    expect(LockEpoch.parse(1).ok).toBe(true);
    expect(LockEpoch.parse(1.5).ok).toBe(false);
  });
});
