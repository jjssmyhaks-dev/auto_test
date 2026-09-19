import { createHmac, createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export interface BlobStore {
  put(key: string, bytes: Buffer, contentType?: string): Promise<string>;
  get(key: string): Promise<Buffer | undefined>;
  list(prefix: string): Promise<string[]>;
  /** Remove every blob under a prefix (demo reset). Returns count removed. */
  deleteByPrefix(prefix: string): Promise<number>;
  kind: string;
}

export class FsBlobStore implements BlobStore {
  readonly kind = "filesystem";
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }
  async put(key: string, bytes: Buffer): Promise<string> {
    const abs = join(this.root, key.replaceAll("..", "_"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    return `fs://${key}`;
  }
  async get(key: string): Promise<Buffer | undefined> {
    const abs = join(this.root, key.replaceAll("..", "_"));
    if (!existsSync(abs)) return undefined;
    return readFileSync(abs);
  }
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        const key = rel ? `${rel}/${name}` : name;
        try {
          if (statSync(abs).isDirectory()) walk(abs, key);
          else if (key.startsWith(prefix) || `/${key}`.includes(`/${prefix}`)) out.push(key.replaceAll("\\", "/"));
        } catch {
          /* skip */
        }
      }
    };
    walk(this.root, "");
    return out.filter((k) => k.replaceAll("\\", "/").startsWith(prefix.replaceAll("\\", "/")));
  }
  async deleteByPrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix);
    for (const key of keys) {
      const abs = join(this.root, key.replaceAll("..", "_").replaceAll("/", sep));
      try {
        rmSync(abs, { force: true });
      } catch {
        /* best-effort */
      }
    }
    return keys.length;
  }
}

/** Minimal SigV4 PutObject/GetObject for MinIO / S3-compatible APIs. */
export class S3BlobStore implements BlobStore {
  readonly kind = "s3";
  constructor(
    private readonly endpoint: string,
    private readonly bucket: string,
    private readonly accessKey: string,
    private readonly secretKey: string,
    private readonly region = "us-east-1",
    private readonly fallback?: BlobStore,
  ) {}

  private url(key: string) {
    const base = this.endpoint.replace(/\/$/, "");
    return `${base}/${this.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async put(key: string, bytes: Buffer, contentType = "application/octet-stream"): Promise<string> {
    try {
      const url = this.url(key);
      const headers = this.sign("PUT", `/${this.bucket}/${key}`, bytes, contentType);
      const res = await fetch(url, { method: "PUT", headers, body: new Uint8Array(bytes) });
      if (!res.ok) throw new Error(`s3 put ${res.status}`);
      if (this.fallback) await this.fallback.put(key, bytes, contentType);
      return url;
    } catch (err) {
      if (this.fallback) return this.fallback.put(key, bytes, contentType);
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    if (this.fallback) return this.fallback.list(prefix);
    return [];
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    if (this.fallback) return this.fallback.deleteByPrefix(prefix);
    return 0;
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      const url = this.url(key);
      const headers = this.sign("GET", `/${this.bucket}/${key}`, Buffer.alloc(0), "application/octet-stream");
      const res = await fetch(url, { method: "GET", headers });
      if (!res.ok) return this.fallback?.get(key);
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return this.fallback?.get(key);
    }
  }

  private sign(method: string, canonicalUri: string, body: Buffer, contentType: string): Record<string, string> {
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const host = new URL(this.endpoint).host;
    const headers: Record<string, string> = {
      host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      "content-type": contentType,
    };
    const signed = ["content-type", "host", "x-amz-content-sha256", "x-amz-date"];
    const canonicalHeaders = signed.map((h) => `${h}:${headers[h]}\n`).join("");
    const canonical = [
      method,
      canonicalUri,
      "",
      canonicalHeaders,
      signed.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonical).digest("hex"),
    ].join("\n");
    const kDate = hmac(`AWS4${this.secretKey}`, date);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`;
    return headers;
  }
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export async function createBlobStore(): Promise<BlobStore> {
  const fsRoot = process.env.VERIFLOW_BLOBS_DIR ?? join(process.cwd(), ".veriflow-data", "blobs");
  const fs = new FsBlobStore(fsRoot);
  const endpoint = process.env.S3_ENDPOINT;
  if (!endpoint) return fs;
  return new S3BlobStore(
    endpoint,
    process.env.S3_BUCKET ?? "veriflow",
    process.env.S3_ACCESS_KEY ?? process.env.MINIO_ROOT_USER ?? "veriflow",
    process.env.S3_SECRET_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? "veriflowsecret",
    process.env.S3_REGION ?? "us-east-1",
    fs,
  );
}
