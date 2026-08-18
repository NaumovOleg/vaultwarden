// Object storage for attachment/send bytes. Files are client-side encrypted;
// S3 SSE-S3 is enough (ARCHITECTURE §4.5). Direct flow only: Lambda buffers
// the multipart upload (≈4.5 MB ceiling), downloads are presigned GETs.
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ObjectStore {
  putObject(key: string, bytes: Buffer): Promise<void>;
  presignedGetUrl(key: string): Promise<string>;
  deleteObject(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export class S3ObjectStore implements ObjectStore {
  private bucket: string;

  constructor(bucket: string) {
    this.bucket = bucket;
  }

  async putObject(key: string, bytes: Buffer): Promise<void> {
    const client = new S3Client();
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: 'application/octet-stream',
        }),
      );
    } finally {
      client.destroy();
    }
  }

  async presignedGetUrl(key: string): Promise<string> {
    const client = new S3Client();
    try {
      return await getSignedUrl(client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
        expiresIn: 300,
      });
    } finally {
      client.destroy();
    }
  }

  async deleteObject(key: string): Promise<void> {
    const client = new S3Client();
    try {
      await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } finally {
      client.destroy();
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    const client = new S3Client();
    try {
      for (let token = undefined as string | undefined; ; ) {
        const listed = await client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
        );
        const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
        if (keys.length > 0) {
          await client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys } }));
        }
        if (!listed.IsTruncated) break;
        token = listed.NextContinuationToken;
      }
    } finally {
      client.destroy();
    }
  }
}

// In-memory store for unit tests. Presigned URLs are fake `mem://` refs —
// tests assert key routing, not AWS signatures.
export class MemoryObjectStore implements ObjectStore {
  private objects = new Map<string, Buffer>();

  async putObject(key: string, bytes: Buffer): Promise<void> {
    this.objects.set(key, bytes);
  }

  async presignedGetUrl(key: string): Promise<string> {
    return `mem://${key}`;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const k of this.objects.keys()) {
      if (k.startsWith(prefix)) this.objects.delete(k);
    }
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }

  get(key: string): Buffer | undefined {
    return this.objects.get(key);
  }
}