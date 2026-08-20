import type { APIGatewayProxyEventV2, APIGatewayProxyResult } from 'aws-lambda';
import { config, alive, now, version, domainsGet, domainsPut, hibpBreach } from './endpoints/misc';
import { register, sendVerificationEmail, verificationEmailClicked, prelogin, token, endsession, recoverPassword, recoverTwoFactor } from './endpoints/identity';
import { deviceList, deviceCreate, deviceById, deviceRegisterToken, deviceClearToken, knownDevice } from './endpoints/devices';
import {
  profile,
  revisionDate,
  keys,
  sync,
  changePassword,
  changeKdf,
  rotateSecurityStamp,
  verifyPassword,
  passwordHint,
  setPasswordHint,
  recoverReset,
  changeEmail,
  verifyEmail,
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
  cipherSoftDelete,
  cipherRestore,
  cipherArchive,
  cipherUnarchive,
  cipherBulkArchive,
  cipherBulkUnarchive,
  cipherBulkRestore,
  cipherMove,
  cipherPurge,
  cipherBulkDelete,
  cipherBulkSoftDelete,
  cipherImport,
  attachmentCreateV2,
  attachmentUpload,
  attachmentLegacy,
  attachmentGet,
  attachmentDeleteHandler,
  cipherShare,
  cipherAdmin,
  cipherSetCollections,
  cipherOrganizationDetails,
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
import {
  memberInvite,
  memberReinvite,
  memberReinviteBulk,
  memberListAll,
  memberListMini,
  memberUpdate,
  memberDelete,
  memberDeleteBulk,
  memberRevoke,
  memberRestore,
  memberPublicKeys,
  memberAccept,
} from './endpoints/members';
import { policyList, policyGet, policyUpdate } from './endpoints/policies';
import { iconHandler, defaultIconsObjects } from './endpoints/icons';
import {
  twoFactorList,
  getAuthenticator,
  authenticatorEnable,
  authenticatorDisable,
  getRecoveryCodes,
  twoFactorDisable,
  getEmailSetup,
  sendEmailSetup,
  sendEmailLogin,
  emailEnable,
} from './endpoints/two-factor';
import {
  eaTrusted,
  eaGranted,
  eaGet,
  eaPolicies,
  eaInvite,
  eaReinvite,
  eaAccept,
  eaConfirm,
  eaUpdate,
  eaDelete,
  eaInitiate,
  eaApprove,
  eaReject,
  eaView,
  eaTakeover,
  eaPassword,
} from './endpoints/emergency-access';
import { BitwardenError, internalError, notFound, toErrorBody } from './errors';
import { match, Route, RouteContext } from './router';
import { Store, MemoryStore, DynamoStore } from './store';
import { MemoryObjectStore, S3ObjectStore, type ObjectStore } from './objects';
import { sesMailer, type Mailer } from './ses';
import { authenticate } from './auth';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

// Applied to every response (2xx/4xx/5xx, all endpoints) at the single
// choke point below. The static web vault gets the same set from a
// CloudFront response-headers policy (lib/vaultwarden-stack.ts).
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'",
};

function withSecurityHeaders(res: APIGatewayProxyResult): APIGatewayProxyResult {
  if (!res.headers) res.headers = {};
  Object.assign(res.headers, SECURITY_HEADERS);
  // Dev-server CORS (linux: the web vault runs on a separate dev origin).
  res.headers['Access-Control-Allow-Origin'] = '*';
  res.headers['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
  res.headers['Access-Control-Allow-Headers'] = '*';
  return res;
}

// Request body limits: 10MB file uploads (attachment/send file routes,
// beneath the API Gateway 10MB hard cap), 1MB everything else (DDoS).
const MAX_FILE_BODY_BYTES = 10 * 1024 * 1024;
const MAX_API_BODY_BYTES = 1024 * 1024;

function approximateBodyBytes(event: APIGatewayProxyEventV2): number {
  const raw = event.body ?? '';
  return event.isBase64Encoded ? Math.ceil((raw.length / 4) * 3) : Buffer.byteLength(raw);
}

function isFileUploadPath(path: string): boolean {
  return /\/attachment(?:\/|$)/.test(path) || /\/api\/sends\/[^/]+\/file\//.test(path);
}

export interface Deps {
  store: Store;
  objects?: ObjectStore;
  icons?: ObjectStore;
  mailer?: Mailer;
}

function defaultObjects(): ObjectStore {
  return process.env.ATTACHMENTS_BUCKET
    ? new S3ObjectStore(process.env.ATTACHMENTS_BUCKET)
    : new MemoryObjectStore();
}

const defaultDeps: Deps = {
  // The Lambda must use the real table: MemoryStore dies with the container and
  // every cold start sees an empty vault (401s, lost data). Dev server selects
  // via VAULT_TABLE too, but the Lambda entry can't rely on that alone.
  store: process.env.VAULT_TABLE ? new DynamoStore(process.env.VAULT_TABLE) : new MemoryStore(),
  objects: defaultObjects(),
};

export const defaultRoutes: Route[] = [
  { method: 'GET', pattern: '/alive', handler: alive },
  { method: 'GET', pattern: '/now', handler: now },
  { method: 'GET', pattern: '/api/version', handler: version },
  { method: 'GET', pattern: '/api/settings/domains', handler: domainsGet, auth: true },
  { method: 'PUT', pattern: '/api/settings/domains', handler: domainsPut, auth: true },
  { method: 'POST', pattern: '/api/settings/domains', handler: domainsPut, auth: true },
  { method: 'GET', pattern: '/api/hibp/breach', handler: hibpBreach, auth: true },
  { method: 'GET', pattern: '/icons/:host/icon.png', handler: iconHandler },
  { method: 'GET', pattern: '/api/config', handler: config },
  { method: 'POST', pattern: '/identity/accounts/register/send-verification-email', handler: sendVerificationEmail },
  { method: 'POST', pattern: '/identity/accounts/register/verification-email-clicked', handler: verificationEmailClicked },
  { method: 'POST', pattern: '/api/accounts/register/verification-email-clicked', handler: verificationEmailClicked },
  { method: 'POST', pattern: '/identity/accounts/register/finish', handler: register },
  { method: 'POST', pattern: '/api/accounts/register/finish', handler: register },
  { method: 'POST', pattern: '/identity/accounts/register', handler: register },
  { method: 'POST', pattern: '/api/accounts/register', handler: register },
  { method: 'POST', pattern: '/identity/accounts/prelogin', handler: prelogin },
  { method: 'POST', pattern: '/identity/accounts/prelogin/password', handler: prelogin },
  { method: 'POST', pattern: '/api/accounts/prelogin', handler: prelogin },
  { method: 'POST', pattern: '/identity/accounts/recover', handler: recoverPassword },
  { method: 'POST', pattern: '/identity/accounts/recover/two-factor', handler: recoverTwoFactor },
  { method: 'POST', pattern: '/identity/connect/token', handler: token },
  { method: 'POST', pattern: '/identity/connect/endsession', handler: endsession },
  { method: 'GET', pattern: '/api/devices', handler: deviceList, auth: true },
  { method: 'POST', pattern: '/api/devices', handler: deviceCreate, auth: true },
  { method: 'GET', pattern: '/api/devices/knowndevice', handler: knownDevice },
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
  // Mobile clients trash a cipher with PUT /delete (soft), like the web
  // vault uses PUT /soft-delete; POST/DELETE stay permanent. Matching
  // vaultwarden, where PUT /ciphers/{id}/delete is the soft-delete path.
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/delete', handler: cipherSoftDelete, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/soft-delete', handler: cipherSoftDelete, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/soft-delete', handler: cipherSoftDelete, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/restore', handler: cipherRestore, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/restore', handler: cipherRestore, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/archive', handler: cipherArchive, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/unarchive', handler: cipherUnarchive, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/archive', handler: cipherBulkArchive, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/unarchive', handler: cipherBulkUnarchive, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/restore', handler: cipherBulkRestore, auth: true },
  { method: 'POST', pattern: '/api/ciphers/restore', handler: cipherBulkRestore, auth: true },
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
  { method: 'POST', pattern: '/api/organizations/:id/users/invite', handler: memberInvite, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/users/reinvite', handler: memberReinviteBulk, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/users/delete', handler: memberDeleteBulk, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/users/public-keys', handler: memberPublicKeys, auth: true },
  { method: 'GET', pattern: '/api/organizations/:id/users/mini-details', handler: memberListMini, auth: true },
  { method: 'GET', pattern: '/api/organizations/:id/users', handler: memberListAll, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/users/:memberId/reinvite', handler: memberReinvite, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/users/:memberId/accept', handler: memberAccept, auth: true },
  { method: 'PUT', pattern: '/api/organizations/:id/users/:memberId/revoke', handler: memberRevoke, auth: true },
  { method: 'PUT', pattern: '/api/organizations/:id/users/:memberId/restore', handler: memberRestore, auth: true },
  { method: 'PUT', pattern: '/api/organizations/:id/users/:memberId', handler: memberUpdate, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/users/:memberId', handler: memberUpdate, auth: true },
  { method: 'DELETE', pattern: '/api/organizations/:id/users/:memberId', handler: memberDelete, auth: true },
  { method: 'GET', pattern: '/api/organizations/:id/policies', handler: policyList, auth: true },
  { method: 'GET', pattern: '/api/organizations/:id/policies/:polType', handler: policyGet, auth: true },
  { method: 'PUT', pattern: '/api/organizations/:id/policies/:polType', handler: policyUpdate, auth: true },
  { method: 'POST', pattern: '/api/organizations/:id/policies/:polType', handler: policyUpdate, auth: true },
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
  { method: 'PUT', pattern: '/api/ciphers/delete', handler: cipherBulkSoftDelete, auth: true },
  { method: 'DELETE', pattern: '/api/ciphers', handler: cipherBulkDelete, auth: true },
  { method: 'GET', pattern: '/api/ciphers/organization-details', handler: cipherOrganizationDetails, auth: true },
  { method: 'GET', pattern: '/api/ciphers/organization-details/:organizationId', handler: cipherOrganizationDetails, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/share', handler: cipherShare, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/share', handler: cipherShare, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/admin', handler: cipherAdmin, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/admin', handler: cipherAdmin, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/collections', handler: cipherSetCollections, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/collections', handler: cipherSetCollections, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/collections_v2', handler: cipherSetCollections, auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/collections_v2', handler: cipherSetCollections, auth: true },
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
  { method: 'GET', pattern: '/api/accounts/hint', handler: passwordHint },
  { method: 'POST', pattern: '/api/accounts/password-hint', handler: setPasswordHint, auth: true },
  { method: 'POST', pattern: '/api/accounts/recover/reset', handler: recoverReset },
  { method: 'POST', pattern: '/api/accounts/email', handler: changeEmail, auth: true },
  { method: 'POST', pattern: '/api/accounts/verify-email', handler: verifyEmail },
  { method: 'POST', pattern: '/api/accounts/delete', handler: deleteAccount, auth: true },
  { method: 'DELETE', pattern: '/api/accounts', handler: deleteAccount, auth: true },
  { method: 'PUT', pattern: '/api/accounts/profile', handler: updateProfile, auth: true },
  { method: 'POST', pattern: '/api/accounts/profile', handler: updateProfile, auth: true },
  { method: 'GET', pattern: '/api/two-factor', handler: twoFactorList, auth: true },
  { method: 'POST', pattern: '/api/two-factor/get-authenticator', handler: getAuthenticator, auth: true },
  { method: 'POST', pattern: '/api/two-factor/authenticator', handler: authenticatorEnable, auth: true },
  { method: 'PUT', pattern: '/api/two-factor/authenticator', handler: authenticatorEnable, auth: true },
  { method: 'DELETE', pattern: '/api/two-factor/authenticator', handler: authenticatorDisable, auth: true },
  { method: 'POST', pattern: '/api/two-factor/disable', handler: twoFactorDisable, auth: true },
  { method: 'POST', pattern: '/api/two-factor/get-recover', handler: getRecoveryCodes, auth: true },
  { method: 'POST', pattern: '/api/two-factor/get-email', handler: getEmailSetup, auth: true },
  { method: 'POST', pattern: '/api/two-factor/send-email', handler: sendEmailSetup, auth: true },
  { method: 'POST', pattern: '/api/two-factor/send-email-login', handler: sendEmailLogin },
  { method: 'POST', pattern: '/api/two-factor/email', handler: emailEnable, auth: true },
  { method: 'PUT', pattern: '/api/two-factor/email', handler: emailEnable, auth: true },
  { method: 'GET', pattern: '/api/emergency-access/trusted', handler: eaTrusted, auth: true },
  { method: 'GET', pattern: '/api/emergency-access/granted', handler: eaGranted, auth: true },
  { method: 'GET', pattern: '/api/emergency-access/:id', handler: eaGet, auth: true },
  { method: 'GET', pattern: '/api/emergency-access/:id/policies', handler: eaPolicies, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/invite', handler: eaInvite, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/reinvite', handler: eaReinvite, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/accept', handler: eaAccept, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/confirm', handler: eaConfirm, auth: true },
  { method: 'PUT', pattern: '/api/emergency-access/:id', handler: eaUpdate, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id', handler: eaUpdate, auth: true },
  { method: 'DELETE', pattern: '/api/emergency-access/:id', handler: eaDelete, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/delete', handler: eaDelete, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/initiate', handler: eaInitiate, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/approve', handler: eaApprove, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/reject', handler: eaReject, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/view', handler: eaView, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/takeover', handler: eaTakeover, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/password', handler: eaPassword, auth: true },
];

function json(statusCode: number, body: string): APIGatewayProxyResult {
  return { statusCode, headers: JSON_HEADERS, body };
}

// One-shot body parsing: identity endpoints send form-urlencoded, the rest of
// the API sends JSON. base64 decoding applies to whichever it is.
function parseBody(event: APIGatewayProxyEventV2, mailer: Mailer): Omit<RouteContext, 'store' | 'objects' | 'icons'> {
  const raw = event.body ?? '';
  const bytes = event.isBase64Encoded ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf-8');
  const decoded = bytes.toString('utf-8');
  const rawHeaders = event.headers ?? {};
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v ?? '';
  // Direct TCP peer under CloudFront is the edge IP — shared by every client,
  // unusable for per-IP rate limiting. Real client is the first XFF hop.
  const xff = (headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() ?? '';
  const sourceIp = xff || (event.requestContext.http.sourceIp ?? '');
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
    sourceIp,
    mailer: mailer,
  };
}

export function createHandler(routes: Route[], deps: Deps = defaultDeps) {
  return async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResult> {
    const method = event.requestContext.http.method;
    const path = event.rawPath;

    let result: APIGatewayProxyResult;
    try {
      if (method === 'OPTIONS') {
        result = { statusCode: 204, headers: JSON_HEADERS, body: '' };
      } else {
        const bodyLimit = isFileUploadPath(path) ? MAX_FILE_BODY_BYTES : MAX_API_BODY_BYTES;
        if (approximateBodyBytes(event) > bodyLimit) {
          result = json(413, '{"Message":"Request body too large."}');
        } else {
          const route = match(method, path, routes);
          if (!route) {
            result = json(notFound().status, toErrorBody(notFound()));
          } else {
            const ctx: RouteContext = {
              ...parseBody(event, deps.mailer ?? sesMailer),
              store: deps.store,
              objects: deps.objects ?? defaultObjects(),
              icons: deps.icons ?? defaultIconsObjects(),
            };
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
    return withSecurityHeaders(result);
  };
}

export const handler = createHandler(defaultRoutes);