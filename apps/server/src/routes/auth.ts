import type { FastifyInstance } from "fastify";
import type { Db, UserRow } from "@nekoshelf/core";
import { countUsers, createUser, findUserByUsername } from "@nekoshelf/core";
import { clearSession, currentUser, hashPassword, setSessionCookie, verifyPassword } from "../auth.js";
import type { AppConfig } from "../config.js";

export function publicUser(user: UserRow): {
  id: number;
  username: string;
  role: string;
  createdAt: string;
} {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.created_at,
  };
}

function validateCredentials(body: unknown): { username: string; password: string } {
  const input = body as { username?: unknown; password?: unknown } | null;
  const username = typeof input?.username === "string" ? input.username.trim() : "";
  const password = typeof input?.password === "string" ? input.password : "";
  if (username.length < 1 || username.length > 64) {
    throw Object.assign(new Error("用户名长度需在 1–64 之间"), { statusCode: 400, code: "validation_failed" });
  }
  if (password.length < 8) {
    throw Object.assign(new Error("密码至少 8 位"), { statusCode: 400, code: "validation_failed" });
  }
  return { username, password };
}

export function registerAuthRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  app.get("/api/setup/status", async () => ({ initialized: countUsers(db) > 0 }));

  app.post("/api/setup", async (request, reply) => {
    if (countUsers(db) > 0) {
      return reply.code(409).send({ error: { code: "conflict", message: "已完成初始化" } });
    }
    const { username, password } = validateCredentials(request.body);
    const user = createUser(db, { username, passwordHash: await hashPassword(password) });
    setSessionCookie(db, reply, user, config.sessionTtlMs, {
      userAgent: request.headers["user-agent"],
      ip: request.ip,
    });
    reply.code(201);
    return { user: publicUser(user) };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const { username, password } = validateCredentials(request.body);
    const user = findUserByUsername(db, username);
    if (!user || !(await verifyPassword(user.password_hash, password))) {
      return reply.code(401).send({ error: { code: "bad_credentials", message: "用户名或密码错误" } });
    }
    setSessionCookie(db, reply, user, config.sessionTtlMs, {
      userAgent: request.headers["user-agent"],
      ip: request.ip,
    });
    return { user: publicUser(user) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    clearSession(db, request, reply);
    reply.code(204);
    return undefined;
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) {
      reply.code(401).send({ error: { code: "unauthorized", message: "请先登录" } });
      return undefined;
    }
    return { user: publicUser(user) };
  });
}
