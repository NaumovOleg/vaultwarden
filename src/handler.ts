import type { APIGatewayProxyEventV2, APIGatewayProxyResult } from 'aws-lambda';
import { config, alive, now, version } from './endpoints/misc';
import { register, prelogin, token, endsession } from './endpoints/identity';
import { BitwardenError, internalError, notFound, toErrorBody } from './errors';
import { match, Route, RouteContext } from './router';
import { Store, MemoryStore } from './store';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export interface Deps {
  store: Store;
}

const defaultDeps: Deps = { store: new MemoryStore() };

const defaultRoutes: Route[] = [
  { method: 'GET', pattern: '/alive', handler: alive },
  { method: 'GET', pattern: '/now', handler: now },
  { method: 'GET', pattern: '/api/version', handler: version },
  { method: 'GET', pattern: '/api/config', handler: config },
  { method: 'POST', pattern: '/identity/accounts/register', handler: register },
  { method: 'POST', pattern: '/api/accounts/register', handler: register },
  { method: 'POST', pattern: '/identity/accounts/prelogin', handler: prelogin },
  { method: 'POST', pattern: '/identity/accounts/prelogin/password', handler: prelogin },
  { method: 'POST', pattern: '/api/accounts/prelogin', handler: prelogin },
  { method: 'POST', pattern: '/identity/connect/token', handler: token },
  { method: 'POST', pattern: '/identity/connect/endsession', handler: endsession },
];

function json(statusCode: number, body: string): APIGatewayProxyResult {
  return { statusCode, headers: JSON_HEADERS, body };
}

// One-shot body parsing: identity endpoints send form-urlencoded, the rest of
// the API sends JSON. base64 decoding applies to whichever it is.
function parseBody(event: APIGatewayProxyEventV2): Omit<RouteContext, 'store'> {
  const raw = event.body ?? '';
  const decoded = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf-8') : raw;
  const rawHeaders = event.headers ?? {};
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v ?? '';
  const contentType = headers['content-type'] ?? '';
  let form: URLSearchParams;
  let jsonBody: Record<string, any> = {};
  if (contentType.includes('x-www-form-urlencoded')) {
    form = new URLSearchParams(decoded);
  } else if (decoded !== '') {
    try {
      jsonBody = JSON.parse(decoded);
    } catch {
      jsonBody = {};
    }
    form = new URLSearchParams();
    for (const [k, v] of Object.entries(jsonBody)) {
      if (typeof v === 'string') form.set(k, v);
    }
  } else {
    form = new URLSearchParams();
  }
  return {
    bodyRaw: decoded,
    bodyForm: form,
    bodyJson: jsonBody,
    headers,
    sourceIp: event.requestContext.http.sourceIp ?? '',
  };
}

export function createHandler(routes: Route[], deps: Deps = defaultDeps) {
  return async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResult> {
    const method = event.requestContext.http.method;
    const path = event.rawPath;

    let result: APIGatewayProxyResult;
    try {
      const route = match(method, path, routes);
      if (!route) {
        result = json(notFound().status, toErrorBody(notFound()));
      } else {
        const ctx = parseBody(event);
        result = (await route.handler(route.params, { ...ctx, store: deps.store })) as APIGatewayProxyResult;
      }
    } catch (err) {
      if (err instanceof BitwardenError) {
        result = json(err.status, toErrorBody(err));
      } else {
        console.error('unhandled error', err);
        result = json(internalError().status, toErrorBody(internalError()));
      }
    }

    console.log(
      JSON.stringify({
        requestId: event.requestContext.requestId,
        method,
        path,
        status: result.statusCode,
      }),
    );
    return result;
  };
}

export const handler = createHandler(defaultRoutes);