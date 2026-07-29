/**
 * Resolve TypeScript-style specifiers for Node.
 *
 * Two things tsc, vitest, and the bundler all do that Node does not: the `@/…` path alias, and
 * extensionless relative imports. This hook teaches Node the same rules, so the CLI runs the
 * real source directly — no build step and no second copy of the code to keep in step.
 */
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

const SOURCE_ROOT = resolvePath(process.cwd(), "src");

export async function resolve(specifier, context, next) {
  const candidates = specifier.startsWith("@/")
    ? (() => {
        const base = pathToFileURL(resolvePath(SOURCE_ROOT, specifier.slice(2))).href;
        return [`${base}.ts`, `${base}/index.ts`, base];
      })()
    : [specifier, `${specifier}.ts`, `${specifier}/index.ts`];

  let lastError;
  for (const candidate of candidates) {
    try {
      return await next(candidate, context);
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError;
}
