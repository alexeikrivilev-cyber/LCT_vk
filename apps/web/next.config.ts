import type { NextConfig } from 'next';

const daemonPort = Number(process.env.OD_PORT) || 7456;
const daemonOrigin = `http://127.0.0.1:${daemonPort}`;
const isProduction = process.env.NODE_ENV === 'production';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(isProduction
    ? {
        output: 'export' as const,
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {
        async rewrites() {
          return [
            { source: '/api/:path*', destination: `${daemonOrigin}/api/:path*` },
            { source: '/artifacts/:path*', destination: `${daemonOrigin}/artifacts/:path*` },
            { source: '/frames/:path*', destination: `${daemonOrigin}/frames/:path*` },
          ];
        },
      }),
};

export default nextConfig;
