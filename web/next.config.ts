import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Helt statisk side: `next build` skriver alt til out/
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
