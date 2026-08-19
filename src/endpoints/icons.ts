import type { APIGatewayProxyResult } from 'aws-lambda';
import { MemoryObjectStore, S3ObjectStore, type ObjectStore } from '../objects';
import type { RouteContext } from '../router';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const CACHE_MAX_AGE = 86400; // 24h positive cache
const ICON_KEY = (host: string) => `icons/${host}.png`;

export function defaultIconsObjects(): ObjectStore {
  return process.env.ICONS_BUCKET ? new S3ObjectStore(process.env.ICONS_BUCKET) : new MemoryObjectStore();
}

function normalizeHost(raw: string): string | null {
  let host = raw.toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, '').split('/')[0].split('@').pop() ?? '';
  if (!/^[a-z0-9.-]+(:[0-9]{1,5})?$/.test(host)) return null;
  return host;
}

function iconResponse(bytes: Buffer): APIGatewayProxyResult {
  const png = bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return {
    statusCode: 200,
    headers: {
      'Content-Type': png ? 'image/png' : 'image/x-icon',
      'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`,
    },
    body: bytes.toString('base64'),
    isBase64Encoded: true,
  };
}

function icon404(): APIGatewayProxyResult {
  return { statusCode: 404, headers: JSON_HEADERS, body: '' };
}

// GET /icons/{host}/icon.png — favicon via vaultwarden's upstream, cached in
// ICONS_BUCKET. Empty cached object = negative marker (failed fetch), served
// as 404 without touching the network again.
export async function iconHandler(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const host = normalizeHost(params.host ?? '');
  if (!host) return icon404();

  const cached = await ctx.icons.getObject(ICON_KEY(host));
  if (cached !== null) {
    return cached.length > 0 ? iconResponse(cached) : icon404();
  }

  let bytes: Buffer | null = null;
  // ponytail: single provider (duckduckgo ip3); ip2 fallback for sites whose
  // 32px favicon is missing; a google/bing ladder only if DDG dies long-term.
  for (const u of [`https://icons.duckduckgo.com/ip3/${host}.ico`, `https://icons.duckduckgo.com/ip2/${host}.ico`]) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
      if (res.ok && res.headers.get('content-type')?.includes('image')) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 0 && buf.length < 256_000) {
          bytes = buf;
          break;
        }
      }
    } catch {
      // continue to next upstream
    }
  }

  await ctx.icons.putObject(ICON_KEY(host), bytes ?? Buffer.alloc(0));
  return bytes ? iconResponse(bytes) : icon404();
}

export { normalizeHost };