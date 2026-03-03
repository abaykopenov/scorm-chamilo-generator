import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: false,
  outputFileTracingRoot: path.resolve(process.cwd()),
  serverExternalPackages: ["pdf-parse", "mammoth"]
};

export default nextConfig;
