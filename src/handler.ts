import type { APIGatewayProxyEventV2, APIGatewayProxyResult } from 'aws-lambda';
import { config, alive, now, version } from './endpoints/misc';
import { BitwardenError, internalError, notFound, toErrorBody } from './errors';
import { match, Route } from './router';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const defaultRoutes: Route[] = [
  { method: 'GET', pattern: '/alive', handler: alive },
  { method: 'GET', pattern: '/now', handler: now },
  { method: 'GET', pattern: '/api/version', handler: version },
  { method: 'GET', pattern: '/api/config', handler: config },
];

function json(statusCode: number, body: string): APIGatewayProxyResult {
  return { statusCode, headers: JSON_HEADERS, body };
}

export function createHandler(routes: Route[]) {
  return async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResult> {
    const method = event.requestContext.http.method;
    const path = event.rawPath;

    let result: APIGatewayProxyResult;
    try {
      const route = match(method, path, routes);
      if (!route) {
        result = json(notFound().status, toErrorBody(notFound()));
      } else {
        // ponytail: real body parsing (event.isBase64Encoded) starts in Phase 2
        result = (await route.handler(route.params)) as APIGatewayProxyResult;
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
