import next from "eslint-config-next";
import prettier from "eslint-config-prettier";
import * as espree from "espree";

/**
 * Flat ESLint config (ESLint 9 — flat config).
 *
 * We pin ESLint to the 9.x line: `eslint-config-next@16` bundles plugin
 * versions (eslint-plugin-react etc.) that still call APIs removed in ESLint 10
 * (`context.getFilename`), so it is not yet ESLint-10-ready. Revisit once
 * eslint-config-next ships updated plugins.
 *
 * `eslint-config-next` ships a ready-made flat-config array wiring up the Next,
 * React, React-Hooks, import, and jsx-a11y plugins plus the typescript-eslint
 * parser. We spread it, add project-wide ignores, then let
 * `eslint-config-prettier` turn off every stylistic rule so Prettier owns
 * formatting and ESLint owns correctness. Prettier MUST stay last.
 *
 * @type {import("eslint").Linter.Config[]}
 */
const config = [
  ...next,
  {
    ignores: [".next/**", "out/**", "build/**", "dist/**", "coverage/**", "next-env.d.ts"],
  },
  // Parse plain JS-family files (our config files) with ESLint's native espree
  // instead of eslint-config-next's bundled Babel parser. TypeScript files are
  // already re-parsed by typescript-eslint. This keeps config-file linting
  // decoupled from the Babel parser and forward-compatible with ESLint 10.
  {
    files: ["**/*.{js,cjs,mjs,jsx}"],
    languageOptions: {
      parser: espree,
      ecmaVersion: 2024,
      sourceType: "module",
    },
  },
  // Every route in this app is `force-dynamic`, so a prefetch cannot produce a reusable payload —
  // and while a deployment page polls, each refresh makes every visible link prefetch again.
  // `src/components/ui/link.tsx` wraps `next/link` with prefetching off and explains why; this rule
  // is what keeps that from being a convention someone silently opts out of.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/link.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/link",
              message:
                "Import { Link } from '@/components/ui/link' instead — it disables prefetch.",
            },
          ],
        },
      ],
    },
  },
  prettier,
];

export default config;
