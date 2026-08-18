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
  enabled: boolean;
  premium: boolean;
  createdAt: string;
}

export interface DeviceItem {
  pk: string; // USER#{id}
  sk: string; // DEV#{deviceId}
  name: string | null;
  type: number;
  pushToken: string | null;
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
  putTwoFactorToken(item: TwoFactorItem): Promise<void>;
  getTwoFactorToken(token: string): Promise<TwoFactorItem | null>;
  deleteTwoFactorToken(token: string): Promise<void>;
  getRate(ip: string): Promise<RateItem | null>;
  putRate(item: RateItem): Promise<void>;
  incrementRate(ip: string, ttlSeconds: number): Promise<void>;
  clearRate(ip: string): Promise<void>;
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
}