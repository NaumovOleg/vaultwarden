import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

export interface UserItem {
  pk: string; // USER#{id}
  sk: string; // PROFILE
  id: string;
  email: string;
  passwordHash: string; // base64, PBKDF2-wrapped server-side
  salt: string; // base64
  passwordIterations: number;
  kdfType: number;
  kdfIterations: number;
  kdfMemory: number | null;
  kdfParallelism: number | null;
  securityStamp: string;
  akey: string;
  privateKey: string | null;
  publicKey: string | null;
  name: string;
  masterPasswordHint: string | null;
  enabled: boolean;
  premium: boolean;
  twoFactorEnabled: boolean;
  totpSecret: string | null; // base32; phase 6
  totpPendingSecret: string | null; // key shown on the setup screen, pre-enable
  email2faEnabled: boolean; // phase 6 plan 02
  email2faAddress: string | null; // masked for display
  domainsOverride: { equivalentDomains: string[][]; excludedGlobalEquivalentDomains: number[] } | null; // phase 7
  avatarColor: string;
  masterKeyEncryptedUserKey: string | null;
  masterKeyWrappedUserKey: string | null;
  revisionDate: string; // ISO
  revisionDateMs: number; // epoch ms (pitfall 2.2)
  createdAt: string;
}

export interface DeviceItem {
  pk: string; // USER#{id}
  sk: string; // DEV#{deviceId}
  name: string | null;
  type: number;
  pushToken: string | null;
  creationDate: string;
  lastUsed: string;
  twoFactorRemembered: boolean; // phase 6: skip 2FA on this device
}

export interface SessionItem {
  pk: string; // SESS#{token}
  sk: string; // TOKEN
  userId: string;
  deviceId: string;
  type: 'access' | 'refresh';
  stamp: string;
  expiresAt: number; // epoch seconds (DynamoDB TTL)
  pairedAccess: string | null;
  pairedRefresh: string | null;
}

export interface EmergencyAccessItem {
  pk: string; // EMERG#{grantorId}#{itemId}
  sk: string; // EMERG
  itemId: string;
  grantorId: string;
  granteeId: string | null; // null until accepted
  email: string; // invited address
  status: number; // 0 invited | 1 accepted | 2 confirmed | 3 initiated | 4 approved
  type: number; // 0 viewer | 1 manager
  waitTimeDays: number;
  token: string | null; // accept token; null once accepted
  name: string | null;
  encryptedPrivateKey: string | null; // grantee's (at accept)
  publicKey: string | null; // grantee's (at accept)
  encryptedKey: string | null; // grantor's vault key (at confirm), grantee-pubkey-encrypted
  creationDate: string;
  revisionDate: string;
  GSI1PK: string; // EMERGTOKEN#{token} while invited | EMERGGRANTEE#{granteeId} once accepted
  GSI1SK: string; // EMERG
}

export interface TwoFactorItem {
  pk: string; // TFA#{token}
  sk: string; // TOKEN
  userId: string;
  deviceId: string;
  providers: string[];
  expiresAt: number;
}

export interface RateItem {
  pk: string; // RATE#{ip}
  sk: string; // LOGIN
  count: number;
  expiresAt: number;
}

export interface LoginData {
  uris: { uri: string; match: number | null }[] | null;
  username: string | null;
  password: string | null;
  totp: string | null;
  passwordRevisionDate: string | null;
  fido2Credentials: unknown[] | null;
}

export interface AttachmentItem {
  id: string; // uuid, foreign to cipher id
  url: string; // filled at serialize time (presigned, 5 min)
  fileName: string; // encrypted
  key: string; // encrypted
  size: number;
  sizeName: string;
  object: 'attachment';
}

export interface CipherItem {
  pk: string; // CIPHER#{userId}#{cipherId}
  sk: string; // CIPHER
  id: string;
  type: number;
  name: string;
  notes: string | null;
  favorite: boolean;
  reprompt: number;
  folderId: string | null;
  organizationId: string | null; // orgs = phase 5; null for personal
  creationDate: string;
  revisionDate: string;
  deletedDate: string | null;
  key: string | null;
  login: LoginData | null;
  secureNote: { type: number } | null;
  card: Record<string, unknown> | null;
  identity: Record<string, unknown> | null;
  sshKey: Record<string, unknown> | null;
  bankAccount: Record<string, unknown> | null;
  driversLicense: Record<string, unknown> | null;
  passport: Record<string, unknown> | null;
  fields: { name: string | null; value: string | null; type: number; linkedId: number | null }[] | null;
  passwordHistory: unknown[] | null;
  attachments: AttachmentItem[] | null;
  collectionIds: string[]; // org ciphers only (phase 5 plan 03)
}

// Link row: pk ORGCOLL#{orgId}#{collectionId}, sk CIPHER#{cipherId} — maps
// org ciphers to collections without an index on the cipher row itself.
export interface OrgCollLink {
  pk: string;
  sk: string;
  orgId: string;
  collectionId: string;
  cipherId: string;
}

export interface FolderItem {
  pk: string; // FOLDER#{userId}#{folderId}
  sk: string; // FOLDER
  id: string;
  name: string;
  revisionDate: string;
}

export interface SendItem {
  pk: string; // SEND#{userId}#{sendId}
  sk: string; // SEND
  id: string;
  accessId: string; // 10-char uuid-derived hex, the anonymous handle
  type: number; // 0=text, 1=file
  name: string; // encrypted
  notes: string | null;
  text: { text: string; hidden: boolean } | null; // encrypted
  file: { id: string; fileName: string; size: number; sizeName: string; key: string } | null;
  passwordHash: string | null; // client SHA-256 base64 of send password
  maxAccessCount: number | null;
  accessCount: number;
  expirationDate: string | null;
  deletionDate: string | null;
  disabled: boolean;
  hideEmail: boolean;
  revisionDate: string;
}

// Status: 0=invited, 1=accepted, 2=confirmed, -1=revoked. Type: 0=owner, 1=admin, 2=user, 3=manager.
// id = pk suffix: userId once bound, invite uuid while status 0 (no account yet).
export interface OrgUserItem {
  pk: string; // ORGUSER#{orgId}#{id}
  sk: string; // ORGUSER
  id: string;
  orgId: string;
  userId: string | null;
  email: string;
  status: number;
  type: number;
  accessToken: string | null; // invite token (no-email accept)
  revisionDate: string;
}

export interface PolicyItem {
  pk: string; // ORG#{orgId}#POLICY#{type}
  sk: string; // POLICY
  id: string;
  organizationId: string;
  type: number;
  enabled: boolean;
  data: string; // JSON string, relayed verbatim
}

export interface OrganizationItem {
  pk: string; // ORG#{orgId}
  sk: string; // ORG
  id: string;
  name: string;
  billingEmail: string;
  key: string; // encrypted org key, relayed verbatim
  keys: { publicKey: string; privateKey: string };
  createdAt: string;
  revisionDate: string;
}

export interface CollectionUserRef {
  id: string;
  readOnly: boolean;
  hidePasswords: boolean;
}

export interface CollectionItem {
  pk: string; // COLLECTION#{orgId}#{collectionId}
  sk: string; // COLLECTION
  id: string;
  organizationId: string;
  name: string;
  externalId: string | null;
  hidePasswords: boolean;
  readOnly: boolean;
  manage: boolean;
  users: CollectionUserRef[];
  revisionDate: string;
}

export interface Store {
  getUserByEmail(email: string): Promise<UserItem | null>;
  getUser(userId: string): Promise<UserItem | null>;
  putUser(user: UserItem): Promise<void>;
  getUserByUserId(userId: string): Promise<UserItem | null>;
  listDevices(userId: string): Promise<DeviceItem[]>;
  clearRememberedDevices(userId: string): Promise<void>;
  putEmergencyAccess(item: EmergencyAccessItem): Promise<void>;
  getEmergencyAccess(grantorId: string, itemId: string): Promise<EmergencyAccessItem | null>;
  getEmergencyAccessByToken(token: string): Promise<EmergencyAccessItem | null>;
  deleteEmergencyAccess(grantorId: string, itemId: string): Promise<void>;
  listEmergencyAccessForGrantor(grantorId: string): Promise<EmergencyAccessItem[]>;
  listEmergencyAccessForGrantee(granteeId: string): Promise<EmergencyAccessItem[]>;
  getDevice(userId: string, deviceId: string): Promise<DeviceItem | null>;
  upsertDevice(device: DeviceItem): Promise<void>;
  putSession(session: SessionItem): Promise<void>;
  getSession(token: string): Promise<SessionItem | null>;
  deleteSession(token: string): Promise<void>;
  deleteSessionsForDevice(userId: string, deviceId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  putTwoFactorToken(item: TwoFactorItem): Promise<void>;
  getTwoFactorToken(token: string): Promise<TwoFactorItem | null>;
  deleteTwoFactorToken(token: string): Promise<void>;
  putRecoveryHash(userId: string, hash: string): Promise<void>;
  listRecoveryHashes(userId: string): Promise<string[]>;
  deleteRecoveryHash(userId: string, hash: string): Promise<void>;
  putEmail2faCode(userId: string, code: string, expiresAt: number): Promise<void>;
  getEmail2faCode(userId: string): Promise<string | null>;
  deleteEmail2faCode(userId: string): Promise<void>;
  getRate(ip: string): Promise<RateItem | null>;
  putRate(item: RateItem): Promise<void>;
  incrementRate(ip: string, ttlSeconds: number): Promise<void>;
  clearRate(ip: string): Promise<void>;
  putCipher(cipher: CipherItem): Promise<void>;
  getCipher(userId: string, cipherId: string): Promise<CipherItem | null>;
  listCiphers(userId: string): Promise<CipherItem[]>;
  deleteCipher(userId: string, cipherId: string): Promise<void>;
  listCiphersForUser(userId: string): Promise<CipherItem[]>;
  getOrgCipher(orgId: string, cipherId: string): Promise<CipherItem | null>;
  listOrgCiphers(orgId: string): Promise<CipherItem[]>;
  setOrgCipherCollections(orgId: string, cipherId: string, collectionIds: string[]): Promise<void>;
  listCollectionCipherIds(orgId: string, collectionId: string): Promise<string[]>;
  deleteOrgCipher(orgId: string, cipherId: string): Promise<void>;
  putFolder(folder: FolderItem): Promise<void>;
  getFolder(userId: string, folderId: string): Promise<FolderItem | null>;
  listFolders(userId: string): Promise<FolderItem[]>;
  deleteFolder(userId: string, folderId: string): Promise<void>;
  putSend(send: SendItem): Promise<void>;
  getSend(userId: string, sendId: string): Promise<SendItem | null>;
  listSends(userId: string): Promise<SendItem[]>;
  deleteSend(userId: string, sendId: string): Promise<void>;
  findSendByAccessId(accessId: string): Promise<SendItem | null>;
  putOrganization(org: OrganizationItem): Promise<void>;
  getOrganization(orgId: string): Promise<OrganizationItem | null>;
  deleteOrganization(orgId: string): Promise<void>;
  putOrgUser(member: OrgUserItem): Promise<void>;
  getOrgUser(orgId: string, userId: string): Promise<OrgUserItem | null>;
  listOrgUsers(orgId: string): Promise<OrgUserItem[]>;
  listOrganizationsForUser(userId: string): Promise<OrgUserItem[]>;
  deleteOrgUser(orgId: string, memberId: string): Promise<void>;
  putCollection(col: CollectionItem): Promise<void>;
  getCollection(orgId: string, collectionId: string): Promise<CollectionItem | null>;
  listCollectionsForOrg(orgId: string): Promise<CollectionItem[]>;
  listCollectionsForUser(userId: string): Promise<CollectionItem[]>;
  deleteCollection(orgId: string, collectionId: string): Promise<void>;
  getOrgUserByToken(token: string): Promise<OrgUserItem | null>;
  putPolicy(policy: PolicyItem): Promise<void>;
  getPolicy(orgId: string, type: number): Promise<PolicyItem | null>;
  listPolicies(orgId: string): Promise<PolicyItem[]>;
}

const TABLE = process.env.VAULT_TABLE ?? '';

function emailPk(email: string): string {
  return `USER#${email.toLowerCase()}`;
}

export class DynamoStore implements Store {
  private readonly db: DynamoDBDocumentClient;

  constructor(tableName?: string) {
    this.db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    this.table = tableName ?? TABLE;
  }

  private readonly table: string;

  async getUserByEmail(email: string): Promise<UserItem | null> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': emailPk(email) },
      Limit: 1,
    }));
    if (!res.Items?.length) return null;
    const userId = res.Items[0].id as string;
    return this.getUserByUserId(userId);
  }

  async getUserByUserId(userId: string): Promise<UserItem | null> {
    return this.getUser(userId);
  }

  async getUser(userId: string): Promise<UserItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
    }));
    return (res.Item as UserItem | undefined) ?? null;
  }

  async putUser(user: UserItem): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { ...user, GSI1PK: emailPk(user.email), GSI1SK: 'PROFILE' },
    }));
  }

  async listDevices(userId: string): Promise<DeviceItem[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'DEV#' },
    }));
    return (res.Items as DeviceItem[] | undefined) ?? [];
  }

  async putEmergencyAccess(item: EmergencyAccessItem): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async getEmergencyAccess(grantorId: string, itemId: string): Promise<EmergencyAccessItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `EMERG#${grantorId}#${itemId}`, sk: 'EMERG' },
    }));
    return (res.Item as EmergencyAccessItem | undefined) ?? null;
  }

  // Invite tokens are only live while status 0; accept/register re-key the row
  // to EMERGGRANTEE#..., which kills the token lookup (single GSI1PK per row).
  async getEmergencyAccessByToken(token: string): Promise<EmergencyAccessItem | null> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `EMERGTOKEN#${token}` },
      Limit: 1,
    }));
    return (res.Items?.[0] as EmergencyAccessItem | undefined) ?? null;
  }

  async deleteEmergencyAccess(grantorId: string, itemId: string): Promise<void> {
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `EMERG#${grantorId}#${itemId}`, sk: 'EMERG' },
    }));
  }

  async listEmergencyAccessForGrantor(grantorId: string): Promise<EmergencyAccessItem[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'begins_with(pk, :pk)',
      ExpressionAttributeValues: { ':pk': `EMERG#${grantorId}#` },
    }));
    return (res.Items as EmergencyAccessItem[] | undefined) ?? [];
  }

  async listEmergencyAccessForGrantee(granteeId: string): Promise<EmergencyAccessItem[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `EMERGGRANTEE#${granteeId}` },
    }));
    return (res.Items as EmergencyAccessItem[] | undefined) ?? [];
  }

  async clearRememberedDevices(userId: string): Promise<void> {
    for (const device of await this.listDevices(userId)) {
      if (device.twoFactorRemembered) {
        await this.upsertDevice({ ...device, twoFactorRemembered: false });
      }
    }
  }

  async getDevice(userId: string, deviceId: string): Promise<DeviceItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `USER#${userId}`, sk: `DEV#${deviceId}` },
    }));
    return (res.Item as DeviceItem | undefined) ?? null;
  }

  async upsertDevice(device: DeviceItem): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: device }));
  }

  async putSession(session: SessionItem): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: session }));
  }

  async getSession(token: string): Promise<SessionItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `SESS#${token}`, sk: 'TOKEN' },
    }));
    return (res.Item as SessionItem | undefined) ?? null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `SESS#${token}`, sk: 'TOKEN' },
    }));
  }

  async deleteSessionsForDevice(userId: string, deviceId: string): Promise<void> {
    // ponytail: scans SESS# via GSI would beat a scan; but sessions are
    // direct-key lookups by design — deletion happens by token (rotation,
    // endsession, stamp revocation). Stamp mismatch 401s cover the residual
    // case. Add a SESS-by-device GSI only when ghost-session cleanup shows up
    // as a real problem.
  }

  async deleteUser(userId: string): Promise<void> {
    // ponytail: SESS# rows for this user are left to TTL (max 30d) — they are
    // token-keyed with no GSI; a deleted user's rows 401 on any use anyway.
    const deleteRows = async (prefix: string, sk: string) => {
      const res = await this.db.send(new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'begins_with(pk, :pk) AND sk = :sk',
        ExpressionAttributeValues: { ':pk': prefix, ':sk': sk },
      }));
      const items = (res.Items as { pk: string; sk: string }[] | undefined) ?? [];
      for (const item of items) {
        await this.db.send(new DeleteCommand({
          TableName: this.table,
          Key: { pk: item.pk, sk: item.sk },
        }));
      }
    };
    const userRows = await this.db.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${userId}` },
    }));
    for (const item of (userRows.Items as { pk: string; sk: string }[] | undefined) ?? []) {
      await this.db.send(new DeleteCommand({
        TableName: this.table,
        Key: { pk: item.pk, sk: item.sk },
      }));
    }
    await deleteRows(`CIPHER#${userId}#`, 'CIPHER');
    await deleteRows(`FOLDER#${userId}#`, 'FOLDER');
    await deleteRows(`SEND#${userId}#`, 'SEND');
    // Trust relations die with either side (mirrors the emergency_access FK cascade).
    for (const item of await this.listEmergencyAccessForGrantee(userId)) {
      await this.deleteEmergencyAccess(item.grantorId, item.itemId);
    }
    await deleteRows(`EMERG#${userId}#`, 'EMERG');
    const memberships = await this.listOrganizationsForUser(userId);
    for (const m of memberships) await this.deleteOrgUser(m.orgId, userId);
  }

  async putTwoFactorToken(item: TwoFactorItem): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async getTwoFactorToken(token: string): Promise<TwoFactorItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `TFA#${token}`, sk: 'TOKEN' },
    }));
    return (res.Item as TwoFactorItem | undefined) ?? null;
  }

  async deleteTwoFactorToken(token: string): Promise<void> {
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `TFA#${token}`, sk: 'TOKEN' },
    }));
  }

  async putRecoveryHash(userId: string, hash: string): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { pk: `TFA#${userId}`, sk: `RECOVER#${hash}`, userId },
    }));
  }

  async listRecoveryHashes(userId: string): Promise<string[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `TFA#${userId}`, ':sk': 'RECOVER#' },
    }));
    return ((res.Items ?? []) as { sk: string }[]).map((i) => i.sk.slice('RECOVER#'.length));
  }

  async deleteRecoveryHash(userId: string, hash: string): Promise<void> {
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `TFA#${userId}`, sk: `RECOVER#${hash}` },
    }));
  }

  async putEmail2faCode(userId: string, code: string, expiresAt: number): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { pk: `TFA#${userId}`, sk: `EMAILCODE#${userId}`, code, expiresAt },
    }));
  }

  async getEmail2faCode(userId: string): Promise<string | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `TFA#${userId}`, sk: `EMAILCODE#${userId}` },
    }));
    const item = res.Item as { code?: string; expiresAt?: number } | undefined;
    if (!item?.code || (item.expiresAt ?? 0) < Math.floor(Date.now() / 1000)) return null;
    return item.code;
  }

  async deleteEmail2faCode(userId: string): Promise<void> {
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `TFA#${userId}`, sk: `EMAILCODE#${userId}` },
    }));
  }

  async getRate(ip: string): Promise<RateItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `RATE#${ip}`, sk: 'LOGIN' },
    }));
    return (res.Item as RateItem | undefined) ?? null;
  }

  async putRate(item: RateItem): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async incrementRate(ip: string, ttlSeconds: number): Promise<void> {
    const item = await this.getRate(ip);
    const now = Math.floor(Date.now() / 1000);
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: {
        pk: `RATE#${ip}`,
        sk: 'LOGIN',
        count: (item?.count ?? 0) + 1,
        expiresAt: now + ttlSeconds,
      },
    }));
  }

  async clearRate(ip: string): Promise<void> {
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `RATE#${ip}`, sk: 'LOGIN' },
    }));
  }

  async listCiphers(userId: string): Promise<CipherItem[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'begins_with(pk, :pk) AND sk = :sk',
      ExpressionAttributeValues: { ':pk': `CIPHER#${userId}#`, ':sk': 'CIPHER' },
    }));
    return (res.Items as CipherItem[] | undefined) ?? [];
  }

  async putCipher(cipher: CipherItem): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: cipher }));
  }

  async getCipher(userId: string, cipherId: string): Promise<CipherItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `CIPHER#${userId}#${cipherId}`, sk: 'CIPHER' },
    }));
    return (res.Item as CipherItem | undefined) ?? null;
  }

  async deleteCipher(userId: string, cipherId: string): Promise<void> {
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `CIPHER#${userId}#${cipherId}`, sk: 'CIPHER' },
    }));
  }

  async listCiphersForUser(userId: string): Promise<CipherItem[]> {
    const personal = await this.listCiphers(userId);
    const out = [...personal];
    const seen = new Set(out.map((c) => c.id));
    const memberships = await this.listOrganizationsForUser(userId);
    for (const m of memberships) {
      if (m.status < 2) continue;
      const org = await this.getOrganization(m.orgId);
      if (!org) continue;
      const canAll = m.type <= 1;
      const collections = canAll
        ? await this.listCollectionsForOrg(m.orgId)
        : (await this.listCollectionsForOrg(m.orgId)).filter(
            (col) => col.users.length === 0 || col.users.some((u) => u.id === userId),
          );
      for (const col of collections) {
        for (const cipherId of await this.listCollectionCipherIds(col.organizationId, col.id)) {
          if (seen.has(cipherId)) continue;
          const cipher = await this.getOrgCipher(col.organizationId, cipherId);
          if (cipher) {
            out.push(cipher);
            seen.add(cipherId);
          }
        }
      }
    }
    return out;
  }

  async getOrgCipher(orgId: string, cipherId: string): Promise<CipherItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `CIPHER#${orgId}#${cipherId}`, sk: 'CIPHER' },
    }));
    return (res.Item as CipherItem | undefined) ?? null;
  }

  async listOrgCiphers(orgId: string): Promise<CipherItem[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'begins_with(pk, :pk)',
      ExpressionAttributeValues: { ':pk': `ORGCOLL#${orgId}#` },
    }));
    const ids = new Set<string>();
    for (const link of (res.Items as OrgCollLink[] | undefined) ?? []) ids.add(link.cipherId);
    const out: CipherItem[] = [];
    for (const cipherId of ids) {
      const cipher = await this.getOrgCipher(orgId, cipherId);
      if (cipher) out.push(cipher);
    }
    return out;
  }

  async setOrgCipherCollections(orgId: string, cipherId: string, collectionIds: string[]): Promise<void> {
    const cipher = await this.getOrgCipher(orgId, cipherId);
    if (!cipher) return;
    const oldIds = cipher.collectionIds ?? [];
    for (const colId of oldIds) {
      if (!collectionIds.includes(colId)) {
        await this.db.send(new DeleteCommand({
          TableName: this.table,
          Key: { pk: `ORGCOLL#${orgId}#${colId}`, sk: `CIPHER#${cipherId}` },
        }));
      }
    }
    for (const colId of collectionIds) {
      if (!oldIds.includes(colId)) {
        await this.db.send(new PutCommand({
          TableName: this.table,
          Item: { pk: `ORGCOLL#${orgId}#${colId}`, sk: `CIPHER#${cipherId}`, orgId, collectionId: colId, cipherId },
        }));
      }
    }
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { ...cipher, collectionIds, revisionDate: new Date().toISOString() },
    }));
  }

  async listCollectionCipherIds(orgId: string, collectionId: string): Promise<string[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `ORGCOLL#${orgId}#${collectionId}`, ':sk': 'CIPHER#' },
    }));
    return ((res.Items as OrgCollLink[] | undefined) ?? []).map((l) => l.cipherId);
  }

  async deleteOrgCipher(orgId: string, cipherId: string): Promise<void> {
    const cipher = await this.getOrgCipher(orgId, cipherId);
    for (const colId of cipher?.collectionIds ?? []) {
      await this.db.send(new DeleteCommand({
        TableName: this.table,
        Key: { pk: `ORGCOLL#${orgId}#${colId}`, sk: `CIPHER#${cipherId}` },
      }));
    }
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `CIPHER#${orgId}#${cipherId}`, sk: 'CIPHER' },
    }));
  }

  async putFolder(folder: FolderItem): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: folder }));
  }

  async getFolder(userId: string, folderId: string): Promise<FolderItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `FOLDER#${userId}#${folderId}`, sk: 'FOLDER' },
    }));
    return (res.Item as FolderItem | undefined) ?? null;
  }

  async deleteFolder(userId: string, folderId: string): Promise<void> {
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `FOLDER#${userId}#${folderId}`, sk: 'FOLDER' },
    }));
  }

  async listSends(userId: string): Promise<SendItem[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'begins_with(pk, :pk) AND sk = :sk',
      ExpressionAttributeValues: { ':pk': `SEND#${userId}#`, ':sk': 'SEND' },
    }));
    return (res.Items as SendItem[] | undefined) ?? [];
  }

  async putSend(send: SendItem): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { ...send, GSI1PK: `SENDACCESS#${send.accessId}`, GSI1SK: 'SEND' },
    }));
  }

  async getSend(userId: string, sendId: string): Promise<SendItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `SEND#${userId}#${sendId}`, sk: 'SEND' },
    }));
    return (res.Item as SendItem | undefined) ?? null;
  }

  async findSendByAccessId(accessId: string): Promise<SendItem | null> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `SENDACCESS#${accessId}` },
      Limit: 1,
    }));
    return (res.Items?.[0] as SendItem | undefined) ?? null;
  }

  async deleteSend(userId: string, sendId: string): Promise<void> {
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `SEND#${userId}#${sendId}`, sk: 'SEND' },
    }));
  }

  async putOrganization(org: OrganizationItem): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: org }));
  }

  async getOrganization(orgId: string): Promise<OrganizationItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `ORG#${orgId}`, sk: 'ORG' },
    }));
    return (res.Item as OrganizationItem | undefined) ?? null;
  }

  async deleteOrganization(orgId: string): Promise<void> {
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `ORG#${orgId}`, sk: 'ORG' },
    }));
    const members = await this.listOrgUsers(orgId);
    for (const m of members) await this.deleteOrgUser(orgId, m.id);
  }

  async putOrgUser(member: OrgUserItem): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: {
        ...member,
        // bound → user's org list; invited (no account yet) → invite token lookup
        GSI1PK: member.userId ? `USERORGS#${member.userId}` : `INVITE#${member.accessToken}`,
        GSI1SK: 'ORGUSER',
      },
    }));
  }

  async getOrgUser(orgId: string, memberId: string): Promise<OrgUserItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `ORGUSER#${orgId}#${memberId}`, sk: 'ORGUSER' },
    }));
    return (res.Item as OrgUserItem | undefined) ?? null;
  }

  async getOrgUserByToken(token: string): Promise<OrgUserItem | null> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `INVITE#${token}` },
      Limit: 1,
    }));
    return (res.Items?.[0] as OrgUserItem | undefined) ?? null;
  }

  async listOrgUsers(orgId: string): Promise<OrgUserItem[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'begins_with(pk, :pk) AND sk = :sk',
      ExpressionAttributeValues: { ':pk': `ORGUSER#${orgId}#`, ':sk': 'ORGUSER' },
    }));
    return (res.Items as OrgUserItem[] | undefined) ?? [];
  }

  async listOrganizationsForUser(userId: string): Promise<OrgUserItem[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK = :sk',
      ExpressionAttributeValues: { ':pk': `USERORGS#${userId}`, ':sk': 'ORGUSER' },
    }));
    return (res.Items as OrgUserItem[] | undefined) ?? [];
  }

  async deleteOrgUser(orgId: string, memberId: string): Promise<void> {
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `ORGUSER#${orgId}#${memberId}`, sk: 'ORGUSER' },
    }));
  }

  async putPolicy(policy: PolicyItem): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { ...policy },
    }));
  }

  async getPolicy(orgId: string, type: number): Promise<PolicyItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `ORG#${orgId}#POLICY#${type}`, sk: 'POLICY' },
    }));
    return (res.Item as PolicyItem | undefined) ?? null;
  }

  async listPolicies(orgId: string): Promise<PolicyItem[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'begins_with(pk, :pk) AND sk = :sk',
      ExpressionAttributeValues: { ':pk': `ORG#${orgId}#POLICY#`, ':sk': 'POLICY' },
    }));
    return (res.Items as PolicyItem[] | undefined) ?? [];
  }

  async putCollection(col: CollectionItem): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: col }));
  }

  async getCollection(orgId: string, collectionId: string): Promise<CollectionItem | null> {
    const res = await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `COLLECTION#${orgId}#${collectionId}`, sk: 'COLLECTION' },
    }));
    return (res.Item as CollectionItem | undefined) ?? null;
  }

  async listCollectionsForOrg(orgId: string): Promise<CollectionItem[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'begins_with(pk, :pk) AND sk = :sk',
      ExpressionAttributeValues: { ':pk': `COLLECTION#${orgId}#`, ':sk': 'COLLECTION' },
    }));
    return (res.Items as CollectionItem[] | undefined) ?? [];
  }

  // ponytail: accessible collections = filter of per-org list (orgs per user are
  // few); a USERCOLL GSI becomes worth it when org counts grow.
  async listCollectionsForUser(userId: string): Promise<CollectionItem[]> {
    const memberships = await this.listOrganizationsForUser(userId);
    const out: CollectionItem[] = [];
    for (const m of memberships) {
      const cols = await this.listCollectionsForOrg(m.orgId);
      for (const col of cols) {
        // owner/admin see every org collection regardless of per-user rows
        if (m.type <= 1 || col.users.length === 0 || col.users.some((u) => u.id === userId)) out.push(col);
      }
    }
    return out;
  }

  async deleteCollection(orgId: string, collectionId: string): Promise<void> {
    await this.db.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `COLLECTION#${orgId}#${collectionId}`, sk: 'COLLECTION' },
    }));
  }

  async listFolders(userId: string): Promise<FolderItem[]> {
    const res = await this.db.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'begins_with(pk, :pk) AND sk = :sk',
      ExpressionAttributeValues: { ':pk': `FOLDER#${userId}#`, ':sk': 'FOLDER' },
    }));
    return (res.Items as FolderItem[] | undefined) ?? [];
  }
}

// In-memory store for unit tests. Deleted when a DDB integration test
// replaces it (Phase 3 smoke).
export class MemoryStore implements Store {
  private usersByEmail = new Map<string, UserItem>();
  private users = new Map<string, UserItem>();
  private devices = new Map<string, DeviceItem>();
  private sessions = new Map<string, SessionItem>();
  private twoFactor = new Map<string, Record<string, unknown>>();
  private rates = new Map<string, RateItem>();
  private allCiphers: CipherItem[] = [];
  private allFolders: FolderItem[] = [];
  private allSends: SendItem[] = [];
  private allOrgs: OrganizationItem[] = [];
  private allOrgUsers: OrgUserItem[] = [];
  private allCollections: CollectionItem[] = [];
  private allPolicies: PolicyItem[] = [];
  private allOrgLinks: OrgCollLink[] = [];
  private allEmergency: EmergencyAccessItem[] = [];

  async getUserByEmail(email: string): Promise<UserItem | null> {
    return this.usersByEmail.get(email.toLowerCase()) ?? null;
  }

  async getUser(userId: string): Promise<UserItem | null> {
    return this.users.get(userId) ?? null;
  }

  async getUserByUserId(userId: string): Promise<UserItem | null> {
    return this.users.get(userId) ?? null;
  }

  async putUser(user: UserItem): Promise<void> {
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email.toLowerCase(), user);
  }

  async listDevices(userId: string): Promise<DeviceItem[]> {
    return [...this.devices.values()].filter((d) => d.pk === `USER#${userId}`);
  }

  async clearRememberedDevices(userId: string): Promise<void> {
    for (const device of await this.listDevices(userId)) {
      if (device.twoFactorRemembered) {
        await this.upsertDevice({ ...device, twoFactorRemembered: false });
      }
    }
  }

  async getDevice(userId: string, deviceId: string): Promise<DeviceItem | null> {
    return this.devices.get(`USER#${userId}|DEV#${deviceId}`) ?? null;
  }

  async upsertDevice(device: DeviceItem): Promise<void> {
    this.devices.set(`${device.pk}|${device.sk}`, device);
  }

  async putSession(session: SessionItem): Promise<void> {
    this.sessions.set(session.pk, session);
  }

  async getSession(token: string): Promise<SessionItem | null> {
    return this.sessions.get(`SESS#${token}`) ?? null;
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(`SESS#${token}`);
  }

  async deleteSessionsForDevice(userId: string, deviceId: string): Promise<void> {
    for (const [k, s] of this.sessions) {
      if (s.userId === userId && s.deviceId === deviceId) this.sessions.delete(k);
    }
  }

  async deleteUser(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) {
      this.users.delete(userId);
      this.usersByEmail.delete(user.email.toLowerCase());
    }
    for (const [k, d] of this.devices) {
      if (d.pk === `USER#${userId}`) this.devices.delete(k);
    }
    this.allCiphers = this.allCiphers.filter((c) => !c.pk.startsWith(`CIPHER#${userId}#`));
    this.allFolders = this.allFolders.filter((f) => !f.pk.startsWith(`FOLDER#${userId}#`));
    this.allSends = this.allSends.filter((s) => !s.pk.startsWith(`SEND#${userId}#`));
    this.allOrgUsers = this.allOrgUsers.filter((m) => m.userId !== userId);
    this.allEmergency = this.allEmergency.filter((e) => e.grantorId !== userId && e.granteeId !== userId);
  }

  async putEmergencyAccess(item: EmergencyAccessItem): Promise<void> {
    this.allEmergency = this.allEmergency.filter((e) => e.pk !== item.pk);
    this.allEmergency.push({ ...item });
  }

  async getEmergencyAccess(grantorId: string, itemId: string): Promise<EmergencyAccessItem | null> {
    const found = this.allEmergency.find((e) => e.pk === `EMERG#${grantorId}#${itemId}`);
    return found ? { ...found } : null;
  }

  async getEmergencyAccessByToken(token: string): Promise<EmergencyAccessItem | null> {
    const found = this.allEmergency.find((e) => e.GSI1PK === `EMERGTOKEN#${token}`);
    return found ? { ...found } : null;
  }

  async deleteEmergencyAccess(grantorId: string, itemId: string): Promise<void> {
    this.allEmergency = this.allEmergency.filter((e) => e.pk !== `EMERG#${grantorId}#${itemId}`);
  }

  async listEmergencyAccessForGrantor(grantorId: string): Promise<EmergencyAccessItem[]> {
    return this.allEmergency.filter((e) => e.pk.startsWith(`EMERG#${grantorId}#`)).map((e) => ({ ...e }));
  }

  async listEmergencyAccessForGrantee(granteeId: string): Promise<EmergencyAccessItem[]> {
    return this.allEmergency.filter((e) => e.GSI1PK === `EMERGGRANTEE#${granteeId}`).map((e) => ({ ...e }));
  }

  async putTwoFactorToken(item: TwoFactorItem): Promise<void> {
    this.twoFactor.set(item.pk, { ...item });
  }

  async getTwoFactorToken(token: string): Promise<TwoFactorItem | null> {
    return (this.twoFactor.get(`TFA#${token}`) as TwoFactorItem | undefined) ?? null;
  }

  async deleteTwoFactorToken(token: string): Promise<void> {
    this.twoFactor.delete(`TFA#${token}`);
  }

  async putRecoveryHash(userId: string, hash: string): Promise<void> {
    this.twoFactor.set(`TFA#${userId}#RECOVER#${hash}`, { pk: `TFA#${userId}`, sk: `RECOVER#${hash}`, userId });
  }

  async listRecoveryHashes(userId: string): Promise<string[]> {
    return [...this.twoFactor.keys()]
      .filter((k) => k.startsWith(`TFA#${userId}#RECOVER#`))
      .map((k) => k.slice(`TFA#${userId}#RECOVER#`.length));
  }

  async deleteRecoveryHash(userId: string, hash: string): Promise<void> {
    this.twoFactor.delete(`TFA#${userId}#RECOVER#${hash}`);
  }

  async putEmail2faCode(userId: string, code: string, expiresAt: number): Promise<void> {
    this.twoFactor.set(`TFA#${userId}#EMAILCODE`, { pk: `TFA#${userId}`, sk: `EMAILCODE#${userId}`, code, expiresAt });
  }

  async getEmail2faCode(userId: string): Promise<string | null> {
    const item = this.twoFactor.get(`TFA#${userId}#EMAILCODE`) as { code?: string; expiresAt?: number } | undefined;
    if (!item?.code || (item.expiresAt ?? 0) < Math.floor(Date.now() / 1000)) return null;
    return item.code;
  }

  async deleteEmail2faCode(userId: string): Promise<void> {
    this.twoFactor.delete(`TFA#${userId}#EMAILCODE`);
  }

  async getRate(ip: string): Promise<RateItem | null> {
    return this.rates.get(ip) ?? null;
  }

  async putRate(item: RateItem): Promise<void> {
    this.rates.set(item.pk.replace('RATE#', ''), item);
  }

  async incrementRate(ip: string, ttlSeconds: number): Promise<void> {
    const existing = this.rates.get(ip);
    const now = Math.floor(Date.now() / 1000);
    this.rates.set(ip, {
      pk: `RATE#${ip}`,
      sk: 'LOGIN',
      count: (existing?.count ?? 0) + 1,
      expiresAt: now + ttlSeconds,
    });
  }

  async clearRate(ip: string): Promise<void> {
    this.rates.delete(ip);
  }

  async listCiphers(userId: string): Promise<CipherItem[]> {
    return this.allCiphers
      .filter((c) => c.pk.startsWith(`CIPHER#${userId}#`))
      .map((c) => ({ ...c }));
  }

  async putCipher(cipher: CipherItem): Promise<void> {
    this.allCiphers = this.allCiphers.filter((c) => c.pk !== cipher.pk);
    this.allCiphers.push({ ...cipher });
  }

  async getCipher(userId: string, cipherId: string): Promise<CipherItem | null> {
    const found = this.allCiphers.find((c) => c.pk === `CIPHER#${userId}#${cipherId}`);
    return found ? { ...found } : null;
  }

  async deleteCipher(userId: string, cipherId: string): Promise<void> {
    this.allCiphers = this.allCiphers.filter((c) => c.pk !== `CIPHER#${userId}#${cipherId}`);
  }

  async listCiphersForUser(userId: string): Promise<CipherItem[]> {
    const personal = await this.listCiphers(userId);
    const out = [...personal];
    const seen = new Set(out.map((c) => c.id));
    const memberships = await this.listOrganizationsForUser(userId);
    for (const m of memberships) {
      if (m.status < 2) continue;
      const collections = m.type <= 1
        ? await this.listCollectionsForOrg(m.orgId)
        : (await this.listCollectionsForOrg(m.orgId)).filter(
            (col) => col.users.length === 0 || col.users.some((u) => u.id === userId),
          );
      for (const col of collections) {
        const orgId = col.organizationId;
        for (const cipherId of this.allOrgLinks
          .filter((l) => l.orgId === orgId && l.collectionId === col.id)
          .map((l) => l.cipherId)) {
          if (seen.has(cipherId)) continue;
          const cipher = this.allCiphers.find((c) => c.pk === `CIPHER#${orgId}#${cipherId}`);
          if (cipher) {
            out.push({ ...cipher });
            seen.add(cipherId);
          }
        }
      }
    }
    return out;
  }

  async getOrgCipher(orgId: string, cipherId: string): Promise<CipherItem | null> {
    const found = this.allCiphers.find((c) => c.pk === `CIPHER#${orgId}#${cipherId}`);
    return found ? { ...found } : null;
  }

  async listOrgCiphers(orgId: string): Promise<CipherItem[]> {
    const ids = new Set(this.allOrgLinks.filter((l) => l.orgId === orgId).map((l) => l.cipherId));
    return [...ids]
      .map((id) => this.allCiphers.find((c) => c.pk === `CIPHER#${orgId}#${id}`))
      .filter((c): c is CipherItem => Boolean(c))
      .map((c) => ({ ...c }));
  }

  async setOrgCipherCollections(orgId: string, cipherId: string, collectionIds: string[]): Promise<void> {
    const cipher = this.allCiphers.find((c) => c.pk === `CIPHER#${orgId}#${cipherId}`);
    if (!cipher) return;
    this.allOrgLinks = this.allOrgLinks.filter((l) => !(l.orgId === orgId && l.cipherId === cipherId));
    for (const collectionId of collectionIds) {
      this.allOrgLinks.push({ pk: `ORGCOLL#${orgId}#${collectionId}`, sk: `CIPHER#${cipherId}`, orgId, collectionId, cipherId });
    }
    this.allCiphers = this.allCiphers.map((c) =>
      c.pk === cipher.pk ? { ...c, collectionIds, revisionDate: new Date().toISOString() } : c,
    );
  }

  async listCollectionCipherIds(orgId: string, collectionId: string): Promise<string[]> {
    return this.allOrgLinks.filter((l) => l.orgId === orgId && l.collectionId === collectionId).map((l) => l.cipherId);
  }

  async deleteOrgCipher(orgId: string, cipherId: string): Promise<void> {
    this.allOrgLinks = this.allOrgLinks.filter((l) => !(l.orgId === orgId && l.cipherId === cipherId));
    this.allCiphers = this.allCiphers.filter((c) => c.pk !== `CIPHER#${orgId}#${cipherId}`);
  }

  async putFolder(folder: FolderItem): Promise<void> {
    this.allFolders = this.allFolders.filter((f) => f.pk !== folder.pk);
    this.allFolders.push({ ...folder });
  }

  async getFolder(userId: string, folderId: string): Promise<FolderItem | null> {
    const found = this.allFolders.find((f) => f.pk === `FOLDER#${userId}#${folderId}`);
    return found ? { ...found } : null;
  }

  async deleteFolder(userId: string, folderId: string): Promise<void> {
    this.allFolders = this.allFolders.filter((f) => f.pk !== `FOLDER#${userId}#${folderId}`);
  }

  async listSends(userId: string): Promise<SendItem[]> {
    return this.allSends.filter((s) => s.pk.startsWith(`SEND#${userId}#`)).map((s) => ({ ...s }));
  }

  async putSend(send: SendItem): Promise<void> {
    this.allSends = this.allSends.filter((s) => s.pk !== send.pk);
    this.allSends.push({ ...send });
  }

  async findSendByAccessId(accessId: string): Promise<SendItem | null> {
    const found = this.allSends.find((s) => s.accessId === accessId);
    return found ? { ...found } : null;
  }

  async getSend(userId: string, sendId: string): Promise<SendItem | null> {
    const found = this.allSends.find((s) => s.pk === `SEND#${userId}#${sendId}`);
    return found ? { ...found } : null;
  }

  async deleteSend(userId: string, sendId: string): Promise<void> {
    this.allSends = this.allSends.filter((s) => s.pk !== `SEND#${userId}#${sendId}`);
  }

  async putOrganization(org: OrganizationItem): Promise<void> {
    this.allOrgs = this.allOrgs.filter((o) => o.pk !== org.pk);
    this.allOrgs.push({ ...org });
  }

  async getOrganization(orgId: string): Promise<OrganizationItem | null> {
    const found = this.allOrgs.find((o) => o.pk === `ORG#${orgId}`);
    return found ? { ...found } : null;
  }

  async deleteOrganization(orgId: string): Promise<void> {
    this.allOrgs = this.allOrgs.filter((o) => o.pk !== `ORG#${orgId}`);
    this.allOrgUsers = this.allOrgUsers.filter((m) => m.pk !== `ORGUSER#${orgId}#`);
  }

  async putOrgUser(member: OrgUserItem): Promise<void> {
    this.allOrgUsers = this.allOrgUsers.filter((m) => m.pk !== member.pk);
    this.allOrgUsers.push({ ...member });
  }

  async getOrgUser(orgId: string, memberId: string): Promise<OrgUserItem | null> {
    const found = this.allOrgUsers.find((m) => m.pk === `ORGUSER#${orgId}#${memberId}`);
    return found ? { ...found } : null;
  }

  async getOrgUserByToken(token: string): Promise<OrgUserItem | null> {
    const found = this.allOrgUsers.find((m) => m.accessToken === token);
    return found ? { ...found } : null;
  }

  async listOrgUsers(orgId: string): Promise<OrgUserItem[]> {
    return this.allOrgUsers.filter((m) => m.pk.startsWith(`ORGUSER#${orgId}#`)).map((m) => ({ ...m }));
  }

  async listOrganizationsForUser(userId: string): Promise<OrgUserItem[]> {
    return this.allOrgUsers.filter((m) => m.userId === userId).map((m) => ({ ...m }));
  }

  async deleteOrgUser(orgId: string, memberId: string): Promise<void> {
    this.allOrgUsers = this.allOrgUsers.filter((m) => m.pk !== `ORGUSER#${orgId}#${memberId}`);
  }

  async putPolicy(policy: PolicyItem): Promise<void> {
    this.allPolicies = this.allPolicies.filter((p) => p.pk !== policy.pk);
    this.allPolicies.push({ ...policy });
  }

  async getPolicy(orgId: string, type: number): Promise<PolicyItem | null> {
    const found = this.allPolicies.find((p) => p.pk === `ORG#${orgId}#POLICY#${type}`);
    return found ? { ...found } : null;
  }

  async listPolicies(orgId: string): Promise<PolicyItem[]> {
    return this.allPolicies.filter((p) => p.pk.startsWith(`ORG#${orgId}#POLICY#`)).map((p) => ({ ...p }));
  }

  async putCollection(col: CollectionItem): Promise<void> {
    this.allCollections = this.allCollections.filter((c) => c.pk !== col.pk);
    this.allCollections.push({ ...col });
  }

  async getCollection(orgId: string, collectionId: string): Promise<CollectionItem | null> {
    const found = this.allCollections.find((c) => c.pk === `COLLECTION#${orgId}#${collectionId}`);
    return found ? { ...found } : null;
  }

  async listCollectionsForOrg(orgId: string): Promise<CollectionItem[]> {
    return this.allCollections.filter((c) => c.pk.startsWith(`COLLECTION#${orgId}#`)).map((c) => ({ ...c }));
  }

  async listCollectionsForUser(userId: string): Promise<CollectionItem[]> {
    const memberships = await this.listOrganizationsForUser(userId);
    const out: CollectionItem[] = [];
    for (const m of memberships) {
      for (const col of await this.listCollectionsForOrg(m.orgId)) {
        if (m.type <= 1 || col.users.length === 0 || col.users.some((u) => u.id === userId)) out.push({ ...col });
      }
    }
    return out;
  }

  async deleteCollection(orgId: string, collectionId: string): Promise<void> {
    this.allCollections = this.allCollections.filter((c) => c.pk !== `COLLECTION#${orgId}#${collectionId}`);
  }

  async listFolders(userId: string): Promise<FolderItem[]> {
    return this.allFolders.filter((f) => f.pk.startsWith(`FOLDER#${userId}#`)).map((f) => ({ ...f }));
  }
}