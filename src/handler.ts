import type { APIGatewayProxyEventV2, APIGatewayProxyResult } from 'aws-lambda';
import { config, alive, now, version } from './endpoints/misc';
import { register, prelogin, token, endsession } from './endpoints/identity';
import { deviceList, deviceById, deviceRegisterToken, deviceClearToken } from './endpoints/devices';
import {
  profile,
  revisionDate,
  keys,
  sync,
  changePassword,
  changeKdf,
  rotateSecurityStamp,
  verifyPassword,
  deleteAccount,
  updateProfile,
} from './endpoints/accounts';
import { folderList, folderGet, folderCreate, folderUpdate, folderDelete } from './endpoints/folders';
import {
  cipherList,
  cipherGet,
  cipherCreate,
  cipherUpdate,
  cipherPartial,
  cipherDelete,
  cipherRestore,
  cipherMove,
  cipherPurge,
  cipherBulkDelete,
  cipherImport,
  attachmentCreateV2,
  attachmentUpload,
  attachmentLegacy,
  attachmentGet,
  attachmentDeleteHandler,
} from './endpoints/ciphers';
import {
  sendList,
  sendGet,
  sendCreate,
  sendUpdate,
  sendDelete,
  sendRemovePassword,
  sendFileV2,
  sendFileUpload,
  sendAccess,
  sendFileDownload,
} from './endpoints/sends';
import {
  orgCreate,
  orgGet,
  orgUpdate,
  orgSetKeys,
  orgGetKeys,
  orgPublicKey,
  orgDelete,
  orgLeave,
} from './endpoints/organizations';
import {
  collectionListAll,
  collectionListForOrg,
  collectionGet,
  collectionCreate,
  collectionUpdate,
  collectionDelete,
} from './endpoints/collections';
import { BitwardenError, internalError, notFound, toErrorBody } from './errors';
import { match, Route, RouteContext } from './router';
import { Store, MemoryStore } from './store';
import { MemoryObjectStore, S3ObjectStore, type ObjectStore } from './objects';
import { authenticate } from './auth';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export interface Deps {
  store: Store;
  objects?: ObjectStore;
}

function defaultObjects(): ObjectStore {
  return process.env.ATTACHMENTS_BUCKET
    ? new S3ObjectStore(process.env.ATTACHMENTS_BUCKET)
    : new MemoryObjectStore();
}

const defaultDeps: Deps = { store: new MemoryStore(), objects: defaultObjects() };

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
  { method: 'GET', pattern: '/api/devices', handler: deviceList, auth: true },
  { method: 'GET', pattern: '/api/devices/identifier/:deviceId', handler: deviceById, auth: true },
  { method: 'PUT', pattern: '/api/devices/identifier/:deviceId/token', handler: deviceRegisterToken, auth: true },
  { method: 'POST', pattern: '/api/devices/identifier/:deviceId/token', handler: deviceRegisterToken, auth: true },
  { method: 'PUT', pattern: '/api/devices/identifier/:deviceId/clear-token', handler: deviceClearToken, auth: true },
  { method: 'POST', pattern: '/api/devices/identifier/:deviceId/clear-token', handler: deviceClearToken, auth: true },
  { method: 'GET', pattern: '/api/accounts/profile', handler: profile, auth: true },
  { method: 'GET', pattern: '/api/accounts/revision-date', handler: revisionDate, auth: true },
  { method: 'POST', pattern: '/api/accounts/keys', handler: keys, auth: true },
  { method: 'GET', pattern: '/api/sync', handler: sync, auth: true },
  { method: 'GET', pattern: '/api/ciphers', handler: cipherList, auth: true },
  { method: 'GET', pattern: '/api/ciphers/:cipherId', handler: cipherGet, auth: true },
  { method: 'GET', pattern: '/api/ciphers/:cipherId/details', handler: cipherGet, auth: true },
  { method: 'POST', pattern: '/api/ciphers', handler: cipherCreate, auth: true },
  { method: 'POST', pattern: '/api/ciphers/create', handler: cipherCreate, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId', handler: cipherUpdate, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId', handler: cipherUpdate, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/partial', handler: cipherPartial, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/partial', handler: cipherPartial, auth: true },
  { method: 'DELETE', pattern: '/api/ciphers/:cipherId', handler: cipherDelete, auth: true },
  { method: 'DELETE', pattern: '/api/ciphers/:cipherId/delete', handler: cipherDelete, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/delete', handler: cipherDelete, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/restore', handler: cipherRestore, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/restore', handler: cipherRestore, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/move', handler: cipherMove, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/move', handler: cipherMove, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/move', handler: cipherMove, auth: true },
  { method: 'POST', pattern: '/api/ciphers/move', handler: cipherMove, auth: true },
  { method: 'POST', pattern: '/api/ciphers/purge', handler: cipherPurge, auth: true },
  { method: 'POST', pattern: '/api/ciphers/import', handler: cipherImport, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/attachment/v2', handler: attachmentCreateV2, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/attachment/:attachmentId', handler: attachmentUpload, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/attachment', handler: attachmentLegacy, auth: true },
  { method: 'GET', pattern: '/api/ciphers/:cipherId/attachment/:attachmentId', handler: attachmentGet, auth: true },
  { method: 'DELETE', pattern: '/api/ciphers/:cipherId/attachment/:attachmentId', handler: attachmentDeleteHandler, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/attachment/:attachmentId/delete', handler: attachmentDeleteHandler, auth: true },
  { method: 'DELETE', pattern: '/api/ciphers/:cipherId/attachment/:attachmentId/delete', handler: attachmentDeleteHandler, auth: true },
  { method: 'GET', pattern: '/api/sends', handler: sendList, auth: true },
  { method: 'GET', pattern: '/api/sends/:id', handler: sendGet, auth: true },
  { method: 'POST', pattern: '/api/sends', handler: sendCreate, auth: true },
  { method: 'PUT', pattern: '/api/sends/:id', handler: sendUpdate, auth: true },
  { method: 'DELETE', pattern: '/api/sends/:id', handler: sendDelete, auth: true },
  { method: 'POST', pattern: '/api/sends/:id/delete', handler: sendDelete, auth: true },
  { method: 'PUT', pattern: '/api/sends/:id/remove-password', handler: sendRemovePassword, auth: true },
  { method: 'POST', pattern: '/api/sends/file/v2', handler: sendFileV2, auth: true },
  { method: 'POST', pattern: '/api/sends/:id/file/:fileId', handler: sendFileUpload, auth: true },
  { method: 'POST', pattern: '/api/sends/access/:accessId', handler: sendAccess },
  { method: 'GET', pattern: '/api/sends/:accessId/file/:fileId', handler: sendFileDownload },
  { method: 'POST', pattern: '/api/organizations', handler: orgCreate, auth: true },
  { method: 'GET', pattern: '/api/organizations/:id', handler: orgGet, auth: true },
  { method: 'PUT', pattern: '/api/organizations/:id', handler: orgUpdate, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id', handler: orgUpdate, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/keys', handler: orgSetKeys, auth: true },
  { method: 'GET', pattern: '/api/organizations/:id/keys', handler: orgGetKeys, auth: true },
  { method: 'GET', pattern: '/api/organizations/:id/public-key', handler: orgPublicKey, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/delete', handler: orgDelete, auth: true },
  { method: 'DELETE', pattern: '/api/organizations/:id', handler: orgDelete, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/leave', handler: orgLeave, auth: true },
  { method: 'GET', pattern: '/api/collections', handler: collectionListAll, auth: true },
  { method: 'GET', pattern: '/api/organizations/:id/collections', handler: collectionListForOrg, auth: true },
  { method: 'GET', pattern: '/api/organizations/:id/collections/details', handler: collectionListForOrg, auth: true },
  { method: 'GET', pattern: '/api/organizations/:id/collections/:collectionId/details', handler: collectionGet, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/collections', handler: collectionCreate, auth: true },
  { method: 'PUT', pattern: '/api/organizations/:id/collections/:collectionId', handler: collectionUpdate, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/collections/:collectionId', handler: collectionUpdate, auth: true },
  { method: 'DELETE', pattern: '/api/organizations/:id/collections/:collectionId', handler: collectionDelete, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/collections/:collectionId/delete', handler: collectionDelete, auth: true },
  { method: 'POST', pattern: '/api/ciphers/delete', handler: cipherBulkDelete, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/delete', handler: cipherBulkDelete, auth: true },
  { method: 'GET', pattern: '/api/folders', handler: folderList, auth: true },
  { method: 'GET', pattern: '/api/folders/:folderId', handler: folderGet, auth: true },
  { method: 'POST', pattern: '/api/folders', handler: folderCreate, auth: true },
  { method: 'PUT', pattern: '/api/folders/:folderId', handler: folderUpdate, auth: true },
  { method: 'POST', pattern: '/api/folders/:folderId', handler: folderUpdate, auth: true },
  { method: 'DELETE', pattern: '/api/folders/:folderId', handler: folderDelete, auth: true },
  { method: 'DELETE', pattern: '/api/folders/:folderId/delete', handler: folderDelete, auth: true },
  { method: 'POST', pattern: '/api/folders/:folderId/delete', handler: folderDelete, auth: true },
  { method: 'POST', pattern: '/api/accounts/password', handler: changePassword, auth: true },
  { method: 'POST', pattern: '/api/accounts/kdf', handler: changeKdf, auth: true },
  { method: 'POST', pattern: '/api/accounts/security-stamp', handler: rotateSecurityStamp, auth: true },
  { method: 'POST', pattern: '/api/accounts/verify-password', handler: verifyPassword, auth: true },
  { method: 'POST', pattern: '/api/accounts/delete', handler: deleteAccount, auth: true },
  { method: 'DELETE', pattern: '/api/accounts', handler: deleteAccount, auth: true },
  { method: 'PUT', pattern: '/api/accounts/profile', handler: updateProfile, auth: true },
  { method: 'POST', pattern: '/api/accounts/profile', handler: updateProfile, auth: true },
];

function json(statusCode: number, body: string): APIGatewayProxyResult {
  return { statusCode, headers: JSON_HEADERS, body };
}

// One-shot body parsing: identity endpoints send form-urlencoded, the rest of
// the API sends JSON. base64 decoding applies to whichever it is.
function parseBody(event: APIGatewayProxyEventV2): Omit<RouteContext, 'store' | 'objects'> {
  const raw = event.body ?? '';
  const bytes = event.isBase64Encoded ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf-8');
  const decoded = bytes.toString('utf-8');
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
    bodyBytes: bytes,
    bodyForm: form,
    bodyJson: jsonBody,
    headers,
    query: Object.fromEntries(new URLSearchParams(event.rawQueryString ?? '')),
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
        const ctx: RouteContext = { ...parseBody(event), store: deps.store, objects: deps.objects ?? defaultObjects() };
        if (route.auth) {
          const authn = await authenticate(deps.store, ctx);
          if (!authn) {
            result = { statusCode: 401, headers: JSON_HEADERS, body: '{"Message":"Unauthorized"}' };
          } else {
            ctx.user = authn.user;
            ctx.session = authn.session;
            result = (await route.handler(route.params, ctx)) as APIGatewayProxyResult;
          }
        } else {
          result = (await route.handler(route.params, ctx)) as APIGatewayProxyResult;
        }
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