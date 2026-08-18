import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';
import { MemoryObjectStore } from '../src/objects';
import { register, token } from '../src/endpoints/identity';
import { sync, profile, deleteAccount } from '../src/endpoints/accounts';
import {
  orgCreate,
  orgGet,
  orgUpdate,
  orgSetKeys,
  orgGetKeys,
  orgPublicKey,
  orgDelete,
  orgLeave,
} from '../src/endpoints/organizations';
import {
  collectionListAll,
  collectionListForOrg,
  collectionGet,
  collectionCreate,
  collectionUpdate,
  collectionDelete,
} from '../src/endpoints/collections';
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
} from '../src/endpoints/members';
import { policyList, policyGet, policyUpdate } from '../src/endpoints/policies';

const PASSWORD = Buffer.from('client-hash').toString('base64');

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: register },
  { method: 'POST', pattern: '/identity/connect/token', handler: token },
  { method: 'GET', pattern: '/api/sync', handler: sync, auth: true },
  { method: 'GET', pattern: '/api/accounts/profile', handler: profile, auth: true },
  { method: 'POST', pattern: '/api/accounts/delete', handler: deleteAccount, auth: true },
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
];

function makeEnv() {
  const store = new MemoryStore();
  const objects = new MemoryObjectStore();
  return { store, objects, handler: createHandler(routes, { store, objects }) };
}

function ev(
  method: string,
  rawPath: string,
  body = '',
  token?: string,
  contentType = 'application/json',
): APIGatewayProxyEventV2 {
  const [path, qs] = rawPath.split('?', 2);
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (body) headers['content-type'] = contentType;
  return {
    rawPath: path,
    rawQueryString: qs ?? '',
    body,
    headers,
    requestContext: { http: { method }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

async function seed(env: ReturnType<typeof makeEnv>, email: string): Promise<string> {
  await env.handler(
    ev('POST', '/identity/accounts/register', JSON.stringify({ email, masterPasswordAuthentication: { hash: PASSWORD } })),
  );
  const login = await env.handler(
    ev(
      'POST',
      '/identity/connect/token',
      new URLSearchParams({
        grant_type: 'password',
        username: email,
        password: PASSWORD,
        scope: 'api offline_access',
        deviceIdentifier: 'dev-1',
      }).toString(),
      undefined,
      'application/x-www-form-urlencoded',
    ),
  );
  expect(login.statusCode).toBe(200);
  return JSON.parse(login.body as string).access_token as string;
}

async function createOrg(env: ReturnType<typeof makeEnv>, at: string, name = 'My Org') {
  const r = await env.handler(
    ev(
      'POST',
      '/api/organizations',
      JSON.stringify({
        name,
        billingEmail: 'org@example.com',
        key: 'enc-org-key',
        keys: { publicKey: 'pub', privateKey: 'priv' },
        collectionName: 'Team Vault',
      }),
      at,
    ),
  );
  expect(r.statusCode).toBe(200);
  const user = (await env.store.listOrganizationsForUser((await env.store.getUserByEmail('owner@example.com'))!.id));
  return user[0].orgId;
}

describe('organizations', () => {
  const oldSignups = process.env.SIGNUPS_ALLOWED;
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });
  afterAll(() => {
    process.env.SIGNUPS_ALLOWED = oldSignups;
  });

  it('create org → owner membership + first collection; sync shows org + collection', async () => {
    const env = makeEnv();
    const at = await seed(env, 'owner@example.com');
    const orgId = await createOrg(env, at);

    const got = JSON.parse((await env.handler(ev('GET', `/api/organizations/${orgId}`, '', at))).body as string);
    expect(got.object).toBe('organization');
    expect(got.name).toBe('My Org');
    expect(got.status).toBe(2);
    expect(got.type).toBe(0);
    expect(got.key).toBe('enc-org-key');
    expect(got.selfHost).toBe(true);

    const bundle = JSON.parse((await env.handler(ev('GET', '/api/sync', '', at))).body as string);
    expect(bundle.profile.organizations).toHaveLength(1);
    expect(bundle.profile.organizations[0].id).toBe(orgId);
    expect(bundle.collections).toHaveLength(1);
    expect(bundle.collections[0].name).toBe('Team Vault');
    expect(bundle.collections[0].organizationId).toBe(orgId);
    expect(bundle.collections[0].object).toBe('collectionDetails');

    const prof = JSON.parse((await env.handler(ev('GET', '/api/accounts/profile', '', at))).body as string);
    expect(prof.organizations).toHaveLength(1);
  });

  it('org keys endpoints relay and return keys', async () => {
    const env = makeEnv();
    const at = await seed(env, 'owner@example.com');
    const orgId = await createOrg(env, at);

    const keys = JSON.parse((await env.handler(ev('GET', `/api/organizations/${orgId}/keys`, '', at))).body as string);
    expect(keys).toEqual({ publicKey: 'pub', privateKey: 'priv', key: 'enc-org-key' });
    const pub = JSON.parse((await env.handler(ev('GET', `/api/organizations/${orgId}/public-key`, '', at))).body as string);
    expect(pub.publicKey).toBe('pub');

    await env.handler(
      ev('POST', `/api/organizations/${orgId}/keys`, JSON.stringify({ publicKey: 'pub2', privateKey: 'priv2', key: 'key2' }), at),
    );
    const rotated = JSON.parse((await env.handler(ev('GET', `/api/organizations/${orgId}/keys`, '', at))).body as string);
    expect(rotated).toEqual({ publicKey: 'pub2', privateKey: 'priv2', key: 'key2' });
  });

  it('collection CRUD: create with users, list, details, update, delete', async () => {
    const env = makeEnv();
    const at = await seed(env, 'owner@example.com');
    const orgId = await createOrg(env, at);
    const ownerId = (await env.store.getUserByEmail('owner@example.com'))!.id;

    const created = await env.handler(
      ev('POST', `/api/organizations/${orgId}/collections`, JSON.stringify({ name: 'Docs', users: [{ id: ownerId, readOnly: true, hidePasswords: false }] }), at),
    );
    expect(created.statusCode).toBe(200);

    const cols = JSON.parse((await env.handler(ev('GET', `/api/organizations/${orgId}/collections`, '', at))).body as string);
    expect(cols).toHaveLength(2); // Team Vault + Docs
    const docs = cols.find((c: any) => c.name === 'Docs')!;
    expect(docs.object).toBe('collectionDetails');
    expect(docs.readOnly).toBe(false); // collection-level flag, not member-level

    const details = JSON.parse(
      (await env.handler(ev('GET', `/api/organizations/${orgId}/collections/${docs.id}/details`, '', at))).body as string,
    );
    expect(details.id).toBe(docs.id);

    const updated = await env.handler(
      ev('PUT', `/api/organizations/${orgId}/collections/${docs.id}`, JSON.stringify({ name: 'Docs v2', readOnly: true }), at),
    );
    expect(updated.statusCode).toBe(200);
    const renamed = JSON.parse(
      (await env.handler(ev('GET', `/api/organizations/${orgId}/collections/${docs.id}/details`, '', at))).body as string,
    );
    expect(renamed.name).toBe('Docs v2');
    expect(renamed.readOnly).toBe(true);

    const del = await env.handler(ev('DELETE', `/api/organizations/${orgId}/collections/${docs.id}`, '', at));
    expect(del.statusCode).toBe(200);
    expect(
      (await env.handler(ev('GET', `/api/organizations/${orgId}/collections/${docs.id}/details`, '', at))).statusCode,
    ).toBe(404);
  });

  it('non-member cannot see org or collections; owner can leave and delete cascades', async () => {
    const env = makeEnv();
    const at = await seed(env, 'owner@example.com');
    const at2 = await seed(env, 'stranger@example.com');
    const orgId = await createOrg(env, at);

    expect((await env.handler(ev('GET', `/api/organizations/${orgId}`, '', at2))).statusCode).toBe(404);
    const bundle2 = JSON.parse((await env.handler(ev('GET', '/api/sync', '', at2))).body as string);
    expect(bundle2.profile.organizations).toHaveLength(0);
    expect(bundle2.collections).toHaveLength(0);

    const orgId2 = await createOrg(env, at);
    const del = await env.handler(ev('POST', `/api/organizations/${orgId2}/delete`, '', at));
    expect(del.statusCode).toBe(200);
    expect((await env.handler(ev('GET', `/api/organizations/${orgId2}`, '', at))).statusCode).toBe(404);
    expect((await env.store.listCollectionsForOrg(orgId2))).toHaveLength(0);
  });

  it('last owner cannot leave (403); deleteAccount drops memberships', async () => {
    const env = makeEnv();
    const at = await seed(env, 'owner@example.com');
    const orgId = await createOrg(env, at);
    expect((await env.handler(ev('POST', `/api/organizations/${orgId}/leave`, '', at))).statusCode).toBe(403);
    expect((await env.handler(ev('GET', `/api/organizations/${orgId}`, '', at))).statusCode).toBe(200);

    const userId = (await env.store.getUserByEmail('owner@example.com'))!.id;
    await env.handler(ev('POST', '/api/accounts/delete', JSON.stringify({ masterPasswordHash: PASSWORD }), at));
    expect((await env.store.listOrganizationsForUser(userId))).toHaveLength(0);
  });

  it('invite: list, search, mini-details, reinvite, duplicate 400, last-owner guards', async () => {
    const env = makeEnv();
    const at = await seed(env, 'owner@example.com');
    const orgId = await createOrg(env, at);

    const inv = JSON.parse(
      (await env.handler(
        ev(
          'POST',
          `/api/organizations/${orgId}/users/invite`,
          JSON.stringify({ emails: [{ email: 'alice@example.com', type: 2 }, { email: 'bob@example.com', type: 3 }] }),
          at,
        ),
      )).body as string,
    );
    expect(inv.invites).toHaveLength(2);
    const token1 = inv.invites[0].accessToken as string;

    expect(
      (await env.handler(
        ev('POST', `/api/organizations/${orgId}/users/invite`, JSON.stringify({ emails: [{ email: 'alice@example.com', type: 2 }] }), at),
      )).statusCode,
    ).toBe(400);

    const list = JSON.parse((await env.handler(ev('GET', `/api/organizations/${orgId}/users`, '', at))).body as string);
    expect(list).toHaveLength(3); // owner + 2 invites
    const alice = list.find((m: any) => m.email === 'alice@example.com');
    expect(alice.status).toBe(0);
    expect(alice.type).toBe(2);
    expect(alice.object).toBe('organizationUser');

    const searched = JSON.parse((await env.handler(ev('GET', `/api/organizations/${orgId}/users?search=alice`, '', at))).body as string);
    expect(searched).toHaveLength(1);
    const bobRow = list.find((m: any) => m.email === 'bob@example.com');

    const mini = JSON.parse((await env.handler(ev('GET', `/api/organizations/${orgId}/users/mini-details`, '', at))).body as string);
    expect(mini).toHaveLength(3);

    const re = JSON.parse(
      (await env.handler(ev('POST', `/api/organizations/${orgId}/users/${alice.id}/reinvite`, '', at))).body as string,
    );
    expect(re.invites[0].accessToken).not.toBe(token1);

    const ownerRow = list.find((m: any) => m.type === 0);
    expect((await env.handler(ev('DELETE', `/api/organizations/${orgId}/users/${ownerRow.id}`, '', at))).statusCode).toBe(400);
    expect(
      (await env.handler(ev('PUT', `/api/organizations/${orgId}/users/${ownerRow.id}`, JSON.stringify({ type: 2 }), at))).statusCode,
    ).toBe(400);

    // bulk delete the invites
    const bulk = await env.handler(
      ev('POST', `/api/organizations/${orgId}/users/delete`, JSON.stringify({ userIds: [alice.id, bobRow.id] }), at),
    );
    expect(bulk.statusCode).toBe(200);
    expect((await env.store.listOrgUsers(orgId))).toHaveLength(1);
  });

  it('invite → accept binds account; role edit; revoke; restore; remove; public-keys', async () => {
    const env = makeEnv();
    const at = await seed(env, 'owner@example.com');
    const at2 = await seed(env, 'alice@example.com');
    const orgId = await createOrg(env, at);

    const inv = JSON.parse(
      (await env.handler(
        ev('POST', `/api/organizations/${orgId}/users/invite`, JSON.stringify({ emails: [{ email: 'alice@example.com', type: 2 }] }), at),
      )).body as string,
    );
    const tk = inv.invites[0].accessToken as string;
    const memberId = (await env.store.listOrgUsers(orgId)).find((m) => m.email === 'alice@example.com')!.id;

    expect((await env.handler(ev('GET', `/api/organizations/${orgId}`, '', at2))).statusCode).toBe(404);
    expect(
      (await env.handler(ev('POST', `/api/organizations/${orgId}/users/${memberId}/accept`, JSON.stringify({ token: 'nope' }), at2))).statusCode,
    ).toBe(400);

    const acc = await env.handler(
      ev('POST', `/api/organizations/${orgId}/users/${memberId}/accept`, JSON.stringify({ token: tk }), at2),
    );
    expect(acc.statusCode).toBe(200);
    const got = JSON.parse((await env.handler(ev('GET', `/api/organizations/${orgId}`, '', at2))).body as string);
    expect(got.status).toBe(2);
    expect(got.type).toBe(2);

    const aliceId = (await env.store.getUserByEmail('alice@example.com'))!.id;
    const keys = JSON.parse(
      (await env.handler(ev('POST', `/api/organizations/${orgId}/users/public-keys`, JSON.stringify({ userIds: [aliceId] }), at))).body as string,
    );
    expect(keys).toHaveLength(1);
    expect(keys[0].userId).toBe(aliceId);

    // owner promotes alice to admin; alice cannot manage herself or owners
    expect((await env.handler(ev('PUT', `/api/organizations/${orgId}/users/${aliceId}`, JSON.stringify({ type: 1 }), at))).statusCode).toBe(200);
    expect(
      (await env.handler(ev('PUT', `/api/organizations/${orgId}/users/${aliceId}`, JSON.stringify({ type: 2 }), at2))).statusCode,
    ).toBe(403);
    const ownerRow = (await env.store.listOrgUsers(orgId)).find((m) => m.type === 0)!;
    expect((await env.handler(ev('PUT', `/api/organizations/${orgId}/users/${ownerRow.id}`, JSON.stringify({ type: 2 }), at2))).statusCode).toBe(403);

    // revoke → org invisible; restore → visible
    expect((await env.handler(ev('PUT', `/api/organizations/${orgId}/users/${aliceId}/revoke`, '', at))).statusCode).toBe(200);
    expect((await env.handler(ev('GET', `/api/organizations/${orgId}`, '', at2))).statusCode).toBe(404);
    expect((await env.handler(ev('PUT', `/api/organizations/${orgId}/users/${aliceId}/restore`, '', at))).statusCode).toBe(200);
    expect((await env.handler(ev('GET', `/api/organizations/${orgId}`, '', at2))).statusCode).toBe(200);

    expect((await env.handler(ev('DELETE', `/api/organizations/${orgId}/users/${aliceId}`, '', at))).statusCode).toBe(200);
    expect((await env.handler(ev('GET', `/api/organizations/${orgId}`, '', at2))).statusCode).toBe(404);
  });

  it('register with orgInviteToken binds + confirms membership; bad token leaves no account', async () => {
    const env = makeEnv();
    const at = await seed(env, 'owner@example.com');
    const orgId = await createOrg(env, at);
    const inv = JSON.parse(
      (await env.handler(
        ev('POST', `/api/organizations/${orgId}/users/invite`, JSON.stringify({ emails: [{ email: 'bob@example.com', type: 2 }] }), at),
      )).body as string,
    );
    const tk = inv.invites[0].accessToken as string;

    expect(
      (
        await env.handler(
          ev(
            'POST',
            '/identity/accounts/register',
            JSON.stringify({ email: 'bogus@example.com', masterPasswordAuthentication: { hash: PASSWORD }, orgInviteToken: 'bad-token' }),
          ),
        )
      ).statusCode,
    ).toBe(400);
    expect(await env.store.getUserByEmail('bogus@example.com')).toBeNull();

    const r = await env.handler(
      ev(
        'POST',
        '/identity/accounts/register',
        JSON.stringify({ email: 'bob@example.com', masterPasswordAuthentication: { hash: PASSWORD }, orgInviteToken: tk }),
      ),
    );
    expect(r.statusCode).toBe(200);

    const login = await env.handler(
      ev(
        'POST',
        '/identity/connect/token',
        new URLSearchParams({
          grant_type: 'password',
          username: 'bob@example.com',
          password: PASSWORD,
          scope: 'api offline_access',
          deviceIdentifier: 'dev-2',
        }).toString(),
        undefined,
        'application/x-www-form-urlencoded',
      ),
    );
    const at2 = JSON.parse(login.body as string).access_token as string;
    expect((await env.handler(ev('GET', `/api/organizations/${orgId}`, '', at2))).statusCode).toBe(200);
    const bundle = JSON.parse((await env.handler(ev('GET', '/api/sync', '', at2))).body as string);
    expect(bundle.profile.organizations).toHaveLength(1);
    expect(bundle.profile.organizations[0].status).toBe(2);
  });

  it('policies: owner writes, member reads, non-admin cannot write; sync relays', async () => {
    const env = makeEnv();
    const at = await seed(env, 'owner@example.com');
    const at2 = await seed(env, 'alice@example.com');
    const orgId = await createOrg(env, at);

    const inv = JSON.parse(
      (await env.handler(
        ev('POST', `/api/organizations/${orgId}/users/invite`, JSON.stringify({ emails: [{ email: 'alice@example.com', type: 2 }] }), at),
      )).body as string,
    );
    const tk = inv.invites[0].accessToken as string;
    const memberId = (await env.store.listOrgUsers(orgId)).find((m) => m.email === 'alice@example.com')!.id;
    await env.handler(ev('POST', `/api/organizations/${orgId}/users/${memberId}/accept`, JSON.stringify({ token: tk }), at2));

    const put = await env.handler(
      ev('PUT', `/api/organizations/${orgId}/policies/4`, JSON.stringify({ enabled: true, data: { displayName: 'X' } }), at),
    );
    expect(put.statusCode).toBe(200);
    expect((put.body as string).includes('"enabled":true')).toBe(true);

    const list = JSON.parse((await env.handler(ev('GET', `/api/organizations/${orgId}/policies`, '', at))).body as string);
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe(4);
    expect(list[0].enabled).toBe(true);
    expect(list[0].data).toBe(JSON.stringify({ displayName: 'X' }));

    expect((await env.handler(ev('GET', `/api/organizations/${orgId}/policies/4`, '', at2))).statusCode).toBe(200);
    expect(
      (await env.handler(ev('PUT', `/api/organizations/${orgId}/policies/4`, JSON.stringify({ enabled: false }), at2))).statusCode,
    ).toBe(403);

    const bundle = JSON.parse((await env.handler(ev('GET', '/api/sync', '', at2))).body as string);
    expect(bundle.policies).toHaveLength(1);
    expect(bundle.policies[0].type).toBe(4);
    expect(bundle.policies[0].enabled).toBe(true);
  });
});