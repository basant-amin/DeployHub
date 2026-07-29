// @vitest-environment node
import { describe, expect, it } from "vitest";

import { DEPLOYMENT_STATES } from "@/core/domain";

import { statusMeta } from "./status";

describe("statusMeta", () => {
  it("covers every state the domain can be in", () => {
    for (const state of DEPLOYMENT_STATES) {
      const meta = statusMeta(state);
      expect(meta.label.length, state).toBeGreaterThan(0);
      expect(meta.glyph.length, state).toBeGreaterThan(0);
    }
  });

  /** Colour alone must never carry state: every status needs its own glyph and word. */
  it("gives each distinguishable outcome its own glyph", () => {
    const glyphs = new Set(
      [
        statusMeta("succeeded", "deployed"),
        statusMeta("succeeded", "no_change"),
        statusMeta("failed"),
        statusMeta("rolled_back"),
        statusMeta("rollback_failed"),
        statusMeta("queued"),
        statusMeta("building"),
        statusMeta("canceled"),
      ].map((meta) => meta.glyph),
    );
    expect(glyphs.size).toBe(8);
  });

  it("does not call a no-change deployment a success", () => {
    expect(statusMeta("succeeded", "no_change").label).toBe("No change");
    expect(statusMeta("succeeded", "no_change").tone).not.toBe("ok");
    expect(statusMeta("succeeded", "deployed").label).toBe("Succeeded");
  });

  /** Amber, not red: the platform did exactly what it was designed to do. */
  it("treats a rollback as a warning and rollback_failed as an alarm", () => {
    expect(statusMeta("rolled_back").tone).toBe("warn");
    expect(statusMeta("rollback_failed").tone).toBe("bad");
    expect(statusMeta("rollback_failed").label).toBe("Needs attention");
  });

  it("pulses only while work is genuinely in flight", () => {
    expect(statusMeta("building").live).toBe(true);
    expect(statusMeta("promoting").live).toBe(true);
    expect(statusMeta("queued").live).toBe(false);
    expect(statusMeta("succeeded", "deployed").live).toBe(false);
    expect(statusMeta("interrupted").live).toBe(false);
  });

  it("names the active step rather than saying 'deploying' six times", () => {
    expect(statusMeta("building").label).toBe("Building");
    expect(statusMeta("health_checking").label).toBe("Health checking");
    expect(statusMeta("rolling_back").label).toBe("Rolling back");
  });
});
