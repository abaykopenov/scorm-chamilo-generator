import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: false,
  outputFileTracingRoot: path.resolve(process.cwd()),
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "100.66.245.31",
    "100.70.109.122"
  ],
  webpack: (config, { dev }) => {
    if (dev) {
      const existingIgnored = config.watchOptions?.ignored;
      const ignoredList = Array.isArray(existingIgnored)
        ? existingIgnored.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
        : (typeof existingIgnored === "string" && existingIgnored.trim().length > 0
            ? [existingIgnored]
            : []);
      const defaultIgnored = ["**/node_modules/**", "**/.git/**", "**/.next/**", "**/.ref_repo/**", "**/._*", "**/.DS_Store"];

      // RAG artifacts are written under .data; avoid dev-server rebuild loops/chunk races.
      config.watchOptions = {
        ...(config.watchOptions || {}),
        ignored: [...new Set([...ignoredList, ...defaultIgnored, "**/.data/**"])]
      };
    }
    return config;
  }
};

export default nextConfig;

