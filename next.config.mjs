import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: false,
  outputFileTracingRoot: path.resolve(process.cwd()),
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "100.66.245.31"
  ],
  webpack: (config, { dev }) => {
    if (dev) {
      const existingIgnored = config.watchOptions?.ignored;
      const ignoredList = Array.isArray(existingIgnored)
        ? existingIgnored
        : (existingIgnored ? [existingIgnored] : []);

      // RAG artifacts are written under .data; avoid dev-server rebuild loops/chunk races.
      config.watchOptions = {
        ...(config.watchOptions || {}),
        ignored: [...ignoredList, "**/.data/**"]
      };
    }
    return config;
  }
};

export default nextConfig;
