import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CloudCredentials } from "@veriflow/schema";
import { paths, veriflowHome } from "@veriflow/store";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;
const MASK = "[REDACTED]";

export interface VaultRecord {
  [key: string]: string;
}

function loadOrCreateMasterKey(home = veriflowHome()): Buffer {
  const p = paths(home);
  mkdirSync(p.home, { recursive: true });
  const envKey = process.env.VERIFLOW_VAULT_KEY;
  if (envKey && envKey.length >= 16) {
    return scryptSync(envKey, "veriflow-vault-v1", KEY_LEN);
  }
  if (existsSync(p.vaultKey)) {
    return Buffer.from(readFileSync(p.vaultKey, "utf8").trim(), "hex");
  }
  const key = randomBytes(KEY_LEN);
  writeFileSync(p.vaultKey, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  return key;
}

function encryptJson(plaintext: string, key: Buffer): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const derived = scryptSync(key, salt, KEY_LEN);
  const cipher = createCipheriv(ALGO, derived, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("VF1"), salt, iv, tag, enc]);
}

function decryptJson(blob: Buffer, key: Buffer): string {
  if (blob.length < 3 + SALT_LEN + IV_LEN + 16) {
    throw new Error("vault.enc is truncated or corrupt");
  }
  const magic = blob.subarray(0, 3).toString("utf8");
  if (magic !== "VF1") {
    throw new Error("unrecognized vault format");
  }
  const salt = blob.subarray(3, 3 + SALT_LEN);
  const iv = blob.subarray(3 + SALT_LEN, 3 + SALT_LEN + IV_LEN);
  const tag = blob.subarray(3 + SALT_LEN + IV_LEN, 3 + SALT_LEN + IV_LEN + 16);
  const enc = blob.subarray(3 + SALT_LEN + IV_LEN + 16);
  const derived = scryptSync(key, salt, KEY_LEN);
  const decipher = createDecipheriv(ALGO, derived, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export class Vault {
  constructor(private readonly home = veriflowHome()) {}

  private readAll(): VaultRecord {
    const p = paths(this.home);
    if (!existsSync(p.vault)) return {};
    const key = loadOrCreateMasterKey(this.home);
    const raw = decryptJson(readFileSync(p.vault), key);
    return JSON.parse(raw) as VaultRecord;
  }

  private writeAll(record: VaultRecord): void {
    const p = paths(this.home);
    mkdirSync(dirname(p.vault), { recursive: true });
    const key = loadOrCreateMasterKey(this.home);
    const blob = encryptJson(JSON.stringify(record), key);
    writeFileSync(p.vault, blob, { mode: 0o600 });
  }

  get(key: string): string | undefined {
    return this.readAll()[key];
  }

  set(key: string, value: string): void {
    const all = this.readAll();
    all[key] = value;
    this.writeAll(all);
  }

  delete(key: string): void {
    const all = this.readAll();
    delete all[key];
    this.writeAll(all);
  }

  keys(): string[] {
    return Object.keys(this.readAll());
  }

  secretValues(): string[] {
    return Object.values(this.readAll()).filter((v) => v.length > 0);
  }
}

export function maskSecret(value: string): string {
  if (!value) return MASK;
  if (value.length <= 4) return MASK;
  return `${MASK}:${value.slice(0, 1)}…${value.slice(-1)}`;
}

/** Mask known secret strings before LLM context or durable storage. */
export function redactSecrets(
  input: string,
  secrets: string[],
  replacement = MASK,
): string {
  let out = input;
  const unique = [...new Set(secrets.filter((s) => s && s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of unique) {
    if (secret.length < 4) continue;
    out = out.split(secret).join(replacement);
  }
  return out;
}

export function redactDeep<T>(value: T, secrets: string[]): T {
  if (value == null) return value;
  if (typeof value === "string") {
    return redactSecrets(value, secrets) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, secrets)) as T;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        (k === "value" || k === "secretValue") &&
        typeof v === "string" &&
        (obj.secret === true || obj.vaultKey)
      ) {
        next[k] = MASK;
      } else {
        next[k] = redactDeep(v, secrets);
      }
    }
    return next as T;
  }
  return value;
}

export function collectSecretsForRedaction(vault: Vault, extra: string[] = []): string[] {
  return [...vault.secretValues(), ...extra];
}

export function saveEncryptedJson(filePath: string, value: unknown, home = veriflowHome()): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const key = loadOrCreateMasterKey(home);
  writeFileSync(filePath, encryptJson(JSON.stringify(value), key), { mode: 0o600 });
}

export function loadEncryptedJson<T>(filePath: string, home = veriflowHome()): T | undefined {
  if (!existsSync(filePath)) return undefined;
  const key = loadOrCreateMasterKey(home);
  const raw = decryptJson(readFileSync(filePath), key);
  return JSON.parse(raw) as T;
}

export function saveCredentials(creds: CloudCredentials, home = veriflowHome()): void {
  saveEncryptedJson(paths(home).credentials, creds, home);
}

export function loadCredentials(home = veriflowHome()): CloudCredentials | undefined {
  const raw = loadEncryptedJson<unknown>(paths(home).credentials, home);
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.apiUrl !== "string" || typeof obj.token !== "string") return undefined;
  return {
    apiUrl: obj.apiUrl,
    token: obj.token,
    email: typeof obj.email === "string" ? obj.email : undefined,
    projectId: typeof obj.projectId === "string" ? obj.projectId : undefined,
    apiKey: typeof obj.apiKey === "string" ? obj.apiKey : undefined,
  };
}
