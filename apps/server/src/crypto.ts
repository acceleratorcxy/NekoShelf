/**
 * 凭据加密：AES-256-GCM，主密钥落 `/config/master.key`（0600）。
 * 密钥可通过环境变量 MASTER_KEY（base64 32 字节）注入，便于容器/CI。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export function loadMasterKey(configDir: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env.MASTER_KEY?.trim();
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "base64");
    if (key.length !== 32) throw new Error("MASTER_KEY 必须是 base64 编码的 32 字节密钥");
    return key;
  }
  const keyPath = join(configDir, "master.key");
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`master.key 损坏：${keyPath}`);
    return key;
  }
  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Windows 下 chmod 无效，忽略
  }
  return key;
}

export function encryptJson(key: Buffer, payload: unknown): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64")).join(".");
}

export function decryptJson<T>(key: Buffer, sealed: string): T {
  const [ivPart, tagPart, dataPart] = sealed.split(".");
  if (!ivPart || !tagPart || !dataPart) throw new Error("凭据密文格式无效");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}
