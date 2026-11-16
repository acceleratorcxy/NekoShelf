import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db, UserRow } from "@nekoshelf/core";
import { createSession, deleteSession, findUserById, getSessionUser } from "@nekoshelf/core";

/** 会话 Cookie 名；独立客户端（App/Tauri/TV）可用 Bearer Token 替代，见 。 */
export const SESSION_COOKIE = "sid";

const ARGON2_OPTIONS = {
  // OWASP 推荐：19 MiB 内存、2 次迭代、单线程
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* API Token（Bearer 鉴权，                                    */
/* ------------------------------------------------------------------ */

/** Token 明文格式：`nks_<8 位 hex 公开前缀>_<64 位 hex 随机密钥>`。 */
const TOKEN_PATTERN = /^(nks_[0-9a-f]{8})_([0-9a-f]{64})$/;

/** Token 作用域；`write` 隐含 `read`，`admin` 隐含其余全部。 */
export const TOKEN_SCOPES = ["read", "write", "admin"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export function isTokenScope(value: unknown): value is TokenScope {
  return typeof value === "string" && (TOKEN_SCOPES as readonly string[]).includes(value);
}

/** `api_tokens` 表行（schema 见 packages/core/src/db/schema.ts，本仓库不改 schema）。 */
export interface ApiTokenRow {
  id: number;
  user_id: number;
  name: string;
  token_hash: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface IssuedToken {
  /** 完整明文 token，只在创建时返回一次。 */
  token: string;
  /** 展示用前缀，允许出现在列表里。 */
  prefix: string;
  /** 落库值：`<prefix>:<sha256(token)>`。 */
  tokenHash: string;
}

/** 生成新 Token：库里只存 `<prefix>:<sha256>`，明文只返回一次。 */
export function issueApiToken(): IssuedToken {
  const secret = randomBytes(32).toString("hex");
  const prefix = `nks_${randomBytes(4).toString("hex")}`;
  const token = `${prefix}_${secret}`;
  return { token, prefix, tokenHash: `${prefix}:${sha256Hex(token)}` };
}

/** 从 token_hash 列取展示前缀（`<prefix>:<hash>` 的第一段）。 */
export function tokenPrefix(tokenHash: string): string {
  const index = tokenHash.indexOf(":");
  return index === -1 ? tokenHash.slice(0, 12) : tokenHash.slice(0, index);
}

/** 任意明文 Token → 落库值（`<prefix>:<sha256>`）；支持环境变量注入的任意字符串 Token。 */
export function tokenHashFor(token: string): string {
  const prefix = TOKEN_PATTERN.exec(token)?.[1] ?? `env_${sha256Hex(token).slice(0, 8)}`;
  return `${prefix}:${sha256Hex(token)}`;
}

/** 解析 `Authorization: Bearer <token>`；只校验格式，不查库。 */
export function parseBearerToken(header: string | undefined): IssuedToken | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (!token || token.length < 16) return undefined;
  const prefix = TOKEN_PATTERN.exec(token)?.[1] ?? `env_${sha256Hex(token).slice(0, 8)}`;
  return { token, prefix, tokenHash: `${prefix}:${sha256Hex(token)}` };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** scopes 列是 JSON 数组文本，兼容早期的逗号分隔写法。 */
export function parseStoredScopes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    /* 非 JSON：回退到逗号分隔 */
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export type AuthVia = "session" | "token";

export interface AuthContext {
  user: UserRow;
  via: AuthVia;
  /** 会话鉴权为 []；Token 鉴权为库里 scopes。 */
  scopes: string[];
  tokenId?: number;
}

/** onRequest 守卫解析出的上下文；路由里用 authFor 取，避免重复查库。 */
const contexts = new WeakMap<FastifyRequest, AuthContext>();

export function authFor(request: FastifyRequest): AuthContext | undefined {
  return contexts.get(request);
}

export function setAuthFor(request: FastifyRequest, context: AuthContext): void {
  contexts.set(request, context);
}

/**
 * 统一鉴权：Cookie `sid` 优先，失败回退 `Authorization: Bearer`。
 * Bearer 命中时顺手刷新 last_used_at（表有该列）。
 */
export function authenticate(db: Db, request: FastifyRequest): AuthContext | undefined {
  const sessionId = request.cookies[SESSION_COOKIE];
  if (sessionId) {
    const user = getSessionUser(db, sessionId);
    if (user) return { user, via: "session", scopes: [] };
  }
  const bearer = parseBearerToken(request.headers.authorization);
  if (!bearer) return undefined;
  const row = db
    .prepare("SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL")
    .get(bearer.tokenHash) as ApiTokenRow | undefined;
  if (!row) return undefined;
  const user = findUserById(db, row.user_id);
  if (!user) return undefined;
  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  return { user, via: "token", scopes: parseStoredScopes(row.scopes), tokenId: row.id };
}

/** Token 作用域校验：`admin` 全放行；写需要 `write`（或更高），读 `read`/`write` 均可。 */
export function tokenAllows(scopes: string[], method: string): boolean {
  if (scopes.includes("admin")) return true;
  const readOnly = method === "GET" || method === "HEAD";
  return scopes.includes("write") || (readOnly && scopes.includes("read"));
}

/** 从 Cookie 解析当前用户；未登录返回 undefined。Token 请求走守卫缓存。 */
export function currentUser(db: Db, request: FastifyRequest): UserRow | undefined {
  const cached = contexts.get(request);
  if (cached) return cached.user;
  const sessionId = request.cookies[SESSION_COOKIE];
  if (!sessionId) return undefined;
  return getSessionUser(db, sessionId);
}

export function setSessionCookie(
  db: Db,
  reply: FastifyReply,
  user: UserRow,
  ttlMs: number,
  meta: { userAgent?: string; ip?: string },
): string {
  const sessionId = createSession(db, {
    userId: user.id,
    ttlMs,
    userAgent: meta.userAgent,
    ip: meta.ip,
  });
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: false, // 反代 HTTPS 时由前端/部署方决定
    maxAge: Math.floor(ttlMs / 1000),
  });
  return sessionId;
}

export function clearSession(db: Db, request: FastifyRequest, reply: FastifyReply): void {
  const sessionId = request.cookies[SESSION_COOKIE];
  if (sessionId) deleteSession(db, sessionId);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** 未登录统一 401。 */
export function unauthorized(reply: FastifyReply): void {
  reply.code(401).send({ error: { code: "unauthorized", message: "请先登录" } });
}

/**
 * 401 细分（便于客户端区分：没登录 / 会话过期 / Token 不对）：
 * - 带 Authorization 但鉴权失败 → `token_invalid`
 * - 带 sid Cookie 但会话不存在/过期 → `session_expired`
 * - 两者都没有 → `unauthorized`
 */
export function unauthorizedCodeFor(request: {
  headers: Record<string, string | string[] | undefined>;
}): { code: string; message: string } {
  const authorization = request.headers.authorization;
  const hasBearer = typeof authorization === "string" && authorization.trim().length > 0;
  if (hasBearer) {
    return { code: "token_invalid", message: "API Token 无效或已被吊销" };
  }
  const cookie = request.headers.cookie;
  if (typeof cookie === "string" && /(?:^|;\s*)sid=/.test(cookie)) {
    return { code: "session_expired", message: "登录已过期，请重新登录" };
  }
  return { code: "unauthorized", message: "请先登录或使用 API Token" };
}
