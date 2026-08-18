import type { Store } from './store';

export interface Route {
  method: string;
  pattern: string;
  auth?: boolean;
  handler: (params: Record<string, string>, ctx: RouteContext) => unknown;
}

export interface RouteContext {
  store: Store;
  bodyRaw: string;
  bodyForm: URLSearchParams;
  bodyJson: Record<string, any>;
}

export interface Match {
  handler: Route['handler'];
  params: Record<string, string>;
}

// pattern supports exact paths and `:param` segments; exact match wins over
// param match; returns null when nothing matches.
export function match(
  method: string,
  path: string,
  routes: Route[],
): Match | null {
  const exact = routes.find((r) => r.method === method && r.pattern === path);
  if (exact) return { handler: exact.handler, params: {} };

  for (const route of routes) {
    if (route.method !== method || !route.pattern.includes(':')) continue;
    const patternSegments = route.pattern.split('/');
    const pathSegments = path.split('/');
    if (patternSegments.length !== pathSegments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < patternSegments.length; i++) {
      const p = patternSegments[i];
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(pathSegments[i]);
      else if (p !== pathSegments[i]) { ok = false; break; }
    }
    if (ok) return { handler: route.handler, params };
  }
  return null;
}