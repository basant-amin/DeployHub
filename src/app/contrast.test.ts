// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The design system's contrast floor, enforced.
 *
 * Written because the first pass of `globals.css` shipped `--ink-3` at 2.94:1 in dark and 2.56:1 in
 * light — the colour every timestamp, duration, and step label is drawn in. Nobody notices that by
 * looking; the tokens are handsome and the text is legible enough to a reader with good eyesight on a
 * good display. It took measuring to find, so measuring is what keeps it fixed.
 *
 * The tokens are parsed out of the stylesheet rather than duplicated here. A copy would pass forever
 * while the real values drifted.
 */

const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** WCAG 2.2 AA: 4.5:1 for normal-size text. */
const TEXT_FLOOR = 4.5;
/** WCAG 2.2 AA (1.4.11): 3:1 for the boundary of a control you have to find in order to use it. */
const CONTROL_FLOOR = 3;

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

/**
 * Read one token out of a block of the stylesheet.
 *
 * `:root` holds dark; `[data-theme="light"]` holds light. Only six-digit hex is matched — the tinted
 * callout backgrounds carry an alpha channel and are not text or control colours.
 */
function token(theme: "dark" | "light", name: string): string {
  const selector = theme === "dark" ? ":root {" : '[data-theme="light"] {';
  const start = CSS.indexOf(selector);
  expect(start, `${selector} not found`).toBeGreaterThan(-1);
  const block = CSS.slice(start, CSS.indexOf("\n}", start));
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\s*;`).exec(block);
  expect(match, `--${name} not found in ${theme}, or not a six-digit hex`).not.toBeNull();
  return match?.[1] ?? "#000000";
}

/** Every surface a token can end up on. A token has to clear the floor on the worst of them. */
const SURFACES = ["canvas", "surface", "raised"] as const;

/** Text colours, and what each one is actually used for. */
const TEXT_TOKENS = [
  ["ink", "headings, log output, the values you read"],
  ["ink-2", "supporting prose, hints, secondary facts"],
  ["ink-3", "timestamps, durations, line counts, step labels"],
  ["status-ok", "Succeeded"],
  ["status-run", "in-flight states"],
  ["status-warn", "Rolled back, Interrupted"],
  ["status-bad", "Failed, Needs attention"],
  ["status-idle", "Queued, No change"],
  ["status-mute", "Canceled"],
] as const;

describe.each(["dark", "light"] as const)("%s theme", (theme) => {
  it.each(TEXT_TOKENS)(`--%s clears ${TEXT_FLOOR}:1 on every surface (%s)`, (name) => {
    const colour = token(theme, name);
    for (const surface of SURFACES) {
      const ratio = contrast(colour, token(theme, surface));
      expect(
        Number(ratio.toFixed(2)),
        `--${name} (${colour}) on --${surface}: ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(TEXT_FLOOR);
    }
  });

  it(`--field clears ${CONTROL_FLOOR}:1, so an input can be found`, () => {
    // Inputs are filled with `--surface` and sit on `--canvas`, so both matter.
    for (const surface of ["canvas", "surface"] as const) {
      const ratio = contrast(token(theme, "field"), token(theme, surface));
      expect(Number(ratio.toFixed(2)), `--field on --${surface}`).toBeGreaterThanOrEqual(
        CONTROL_FLOOR,
      );
    }
  });

  it("keeps a visible three-step ink ramp, so raising the floor did not flatten the hierarchy", () => {
    /*
     * Stated as contrast against the canvas rather than raw luminance, because the ramp runs in
     * opposite directions in the two themes — lighter away from a dark canvas, darker away from a
     * light one — while "how much it stands out" runs the same way in both.
     */
    const canvas = token(theme, "canvas");
    const standsOut = (name: string) => contrast(token(theme, name), canvas);

    const [ink, ink2, ink3] = [standsOut("ink"), standsOut("ink-2"), standsOut("ink-3")];
    expect(ink, "ink vs ink-2").toBeGreaterThan(ink2 * 1.8);
    expect(ink2, "ink-2 vs ink-3").toBeGreaterThan(ink3 * 1.3);
  });
});

describe("the accent", () => {
  it.each(["dark", "light"] as const)("is legible as a button label in %s", (theme) => {
    // The Deploy button: `--accent-ink` on `--accent`. The one place the accent carries text.
    const ratio = contrast(token(theme, "accent-ink"), token(theme, "accent"));
    expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(4.5);
  });
});
