import type { SessionItem, Store, UserItem } from './store';
import type { ObjectStore } from './objects';

export interface Route {
  method: string;
  pattern: string;
  auth?: boolean;
  handler: (params: Record<string, string>, ctx: RouteContext) => unknown;
}

export interface RouteContext {
  store: Store;
  objects: ObjectStore;
  icons: ObjectStore;
  bodyRaw: string;
  bodyBytes: Buffer;
  bodyForm: URLSearchParams;
  bodyJson: Record<string, any>;
  headers: Record<string, string>;
  query: Record<string, string>;
  sourceIp: string;
  user?: UserItem;
  session?: SessionItem;
}

export interface Match {
  handler: Route['handler'];
  params: Record<string, string>;
  auth?: boolean;
}

// pattern supports exact paths and `:param` segments; exact match wins over
// param match; returns null when nothing matches.
export function match(
  method: string,
  path: string,
  routes: Route[],
): Match | null {
  // Clients call /api/sync/ and /api/devices/ — treat trailing slash as
  // insignificant (root '/' stays as is).
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const exact = routes.find((r) => r.method === method && r.pattern === clean);
  if (exact) return { handler: exact.handler, params: {}, auth: exact.auth };

  for (const route of routes) {
    if (route.method !== method || !route.pattern.includes(':')) continue;
    const patternSegments = route.pattern.split('/');
    const pathSegments = clean.split('/');
    if (patternSegments.length !== pathSegments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < patternSegments.length; i++) {
      const p = patternSegments[i];
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(pathSegments[i]);
      else if (p !== pathSegments[i]) { ok = false; break; }
    }
    if (ok) return { handler: route.handler, params, auth: route.auth };
  }
  return null;
}