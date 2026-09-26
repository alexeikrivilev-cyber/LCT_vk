import type { NextConfig } from 'next';

function configuredPort(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d{1,5}$/.test(raw.trim())) throw new TypeError(`${name} must be an integer between 1 and 65535.`);
  const port = Number(raw.trim());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError(`${name} must be an integer between 1 and 65535.`);
  return port;
}

const daemonPort = configuredPort(process.env.LCT_PORT, 'LCT_PORT', 7456);
const daemonOrigin = `http://127.0.0.1:${daemonPort}`;
const isProduction = process.env.NODE_ENV === 'production';
const devDistDir = process.env.LCT_NEXT_DIST_DIR?.trim();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(devDistDir ? { distDir: devDistDir } : {}),
  experimental: {
    // The daemon accepts two 64 MiB files per multipart request. Rewrites buffer
    // request bodies in Next, so leave room for both files and multipart framing.
    proxyClientMaxBodySize: '130mb',
  },
  ...(isProduction
    ? {
        output: 'export' as const,
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {
        async rewrites() {
          return [{ source: '/api/:path*', destination: `${daemonOrigin}/api/:path*` }];
        },
      }),
};

export default nextConfig;
