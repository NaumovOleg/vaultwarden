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
}

export interface SessionItem {
  pk: string; // SESS#{token}
  sk: string; // TOKEN
  userId: string;
  deviceId: string;
  type: 'access' | 'refresh';
  stamp: string;
  expiresAt: number; // epoch seconds (DynamoDB TTL)
  pairedAccess?: string; // on refresh items: the access token of the pair
  pairedRefresh?: string; // on access items: the refresh token of the pair
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
}

export interface FolderItem {
  pk: string; // FOLDER#{userId}#{folderId}
  sk: string; // FOLDER
  id: string;
  name: string;
  revisionDate: string;
}

export interface Store {
  getUserByEmail(email: string): Promise<UserItem | null>;
  getUser(userId: string): Promise<UserItem | null>;
  putUser(user: UserItem): Promise<void>;
  getUserByUserId(userId: string): Promise<UserItem | null>;
  listDevices(userId: string): Promise<DeviceItem[]>;
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
  getRate(ip: string): Promise<RateItem | null>;
  putRate(item: RateItem): Promise<void>;
  incrementRate(ip: string, ttlSeconds: number): Promise<void>;
  clearRate(ip: string): Promise<void>;
  putCipher(cipher: CipherItem): Promise<void>;
  getCipher(userId: string, cipherId: string): Promise<CipherItem | null>;
  listCiphers(userId: string): Promise<CipherItem[]>;
  deleteCipher(userId: string, cipherId: string): Promise<void>;
  putFolder(folder: FolderItem): Promise<void>;
  getFolder(userId: string, folderId: string): Promise<FolderItem | null>;
  listFolders(userId: string): Promise<FolderItem[]>;
  deleteFolder(userId: string, folderId: string): Promise<void>;
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
      ExpressionAttributeValues: { ':pk': `EMAIL#${email.toLowerCase()}` },
      Limit: 1,
    }));
    if (!res.Items?.length) return null;
    const userId = res.Items[0].userId as string;
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
  private twoFactor = new Map<string, TwoFactorItem>();
  private rates = new Map<string, RateItem>();
  private allCiphers: CipherItem[] = [];
  private allFolders: FolderItem[] = [];

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
  }

  async putTwoFactorToken(item: TwoFactorItem): Promise<void> {
    this.twoFactor.set(item.pk, item);
  }

  async getTwoFactorToken(token: string): Promise<TwoFactorItem | null> {
    return this.twoFactor.get(`TFA#${token}`) ?? null;
  }

  async deleteTwoFactorToken(token: string): Promise<void> {
    this.twoFactor.delete(`TFA#${token}`);
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

  async listFolders(userId: string): Promise<FolderItem[]> {
    return this.allFolders.filter((f) => f.pk.startsWith(`FOLDER#${userId}#`)).map((f) => ({ ...f }));
  }
}