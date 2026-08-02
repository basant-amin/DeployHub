import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server at `.next/standalone`, so the container runs
  // `node server.js` against a traced module graph rather than `next start`
  // against a full `node_modules`. It is what keeps the runtime image free of
  // the Next CLI and its per-platform SWC binaries — see `docs/docker.md`.
  // `next start` still works locally; this only adds an output directory.
  output: "standalone",
  // Fail the production build on type errors — never ship a broken build.
  // (Next 16 removed the built-in `next lint`; linting runs via `npm run lint`.)
  typescript: { ignoreBuildErrors: false },
  reactStrictMode: true,
  // Don't advertise the framework in response headers.
  poweredByHeader: false,
};

export default nextConfig;
