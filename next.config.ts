import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Statement uploads (multiple XLSX/CSV files per request) exceed the
      // 1MB server-action default.
      bodySizeLimit: "16mb",
    },
  },
};

export default nextConfig;
