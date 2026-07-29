import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fail the production build on type errors — never ship a broken build.
  // (Next 16 removed the built-in `next lint`; linting runs via `npm run lint`.)
  typescript: { ignoreBuildErrors: false },
  reactStrictMode: true,
  // Don't advertise the framework in response headers.
  poweredByHeader: false,
};

export default nextConfig;
