import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "@nekoshelf/core";
import { addAuditLog } from "@nekoshelf/core";
import {
  authFor,
  isTokenScope,
  issueApiToken,
  parseStoredScopes,
  tokenPrefix,
  type ApiTokenRow,
  type AuthContext,
  type TokenScope,
} from "../auth.js";
import { HttpError } from "../media.js";

interface TokenDto {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

function tokenDto(row: ApiTokenRow): TokenDto {
  return {
    id: row.id,
    name: row.name,
    prefix: tokenPrefix(row.token_hash),
    scopes: parseStoredScopes(row.scopes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * `/api/auth/tokens*` 仅管理员可用：会话用户须 role=admin；
 * 用 Token 管理 Token 时还要求该 Token 含 `admin` 作用域（防权限提升）。
 */
function requireAdmin(request: FastifyRequest): AuthContext {
  const auth = authFor(request);
  if (!auth) throw new HttpError(401, "unauthorized", "请先登录或使用 API Token");
  if (auth.user.role !== "admin") {
    throw new HttpError(403, "forbidden", "仅管理员可管理 API Token");
  }
  if (auth.via === "token" && !auth.scopes.includes("admin")) {
    throw new HttpError(403, "forbidden", "该 Token 缺少 admin 作用域");
  }
  return auth;
}

function validateName(body: unknown): string {
  const input = body as { name?: unknown } | null;
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 64) {
    throw new HttpError(400, "validation_failed", "name 长度需在 1–64 之间");
  }
  return name;
}

function validateScopes(body: unknown): TokenScope[] {
  const input = body as { scopes?: unknown } | null;
  if (input?.scopes === undefined || input.scopes === null) return ["read"];
  if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
    throw new HttpError(400, "validation_failed", "scopes 必须是非空数组");
  }
  const scopes: TokenScope[] = [];
  for (const raw of input.scopes) {
    if (!isTokenScope(raw)) {
      throw new HttpError(400, "validation_failed", "scopes 仅支持 read / write / admin");
    }
    if (!scopes.includes(raw)) scopes.push(raw);
  }
  return scopes;
}

export function registerTokenRoutes(app: FastifyInstance, db: Db): void {
  app.post("/api/auth/tokens", async (request, reply) => {
    const auth = requireAdmin(request);
    const name = validateName(request.body);
    const scopes = validateScopes(request.body);
    const issued = issueApiToken();
    const createdAt = new Date().toISOString();
    const result = db
      .prepare(
        "INSERT INTO api_tokens (user_id, name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(auth.user.id, name, issued.tokenHash, JSON.stringify(scopes), createdAt);
    const id = Number(result.lastInsertRowid);
    addAuditLog(db, {
      actor: auth.user.username,
      action: "token.create",
      target: `token:${id}`,
      detail: { name, scopes },
    });
    reply.code(201);
    return { id, name, prefix: issued.prefix, scopes, createdAt, token: issued.token };
  });

  app.get("/api/auth/tokens", async (request) => {
    requireAdmin(request);
    const rows = db
      .prepare("SELECT * FROM api_tokens WHERE revoked_at IS NULL ORDER BY id DESC")
      .all() as unknown as ApiTokenRow[];
    return { tokens: rows.map(tokenDto) };
  });

  app.delete("/api/auth/tokens/:id", async (request, reply) => {
    const auth = requireAdmin(request);
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(404, "not_found", "Token 不存在");
    }
    const result = db
      .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id);
    if (result.changes === 0) {
      throw new HttpError(404, "not_found", "Token 不存在");
    }
    addAuditLog(db, {
      actor: auth.user.username,
      action: "token.revoke",
      target: `token:${id}`,
    });
    reply.code(204);
    return undefined;
  });
}
