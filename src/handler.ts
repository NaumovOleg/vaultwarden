import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const NOT_FOUND: APIGatewayProxyResultV2 = {
  statusCode: 404,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ Message: 'Not found.', ModelState: {}, ValidationErrors: [] }),
};

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  console.log(JSON.stringify({ requestId: event.requestContext.requestId, method, path }));

  if (method === 'GET' && path === '/alive') {
    return { statusCode: 200, body: '' };
  }
  return NOT_FOUND;
}