import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Db, LibraryRow, ScanOptions } from "@nekoshelf/core";
import {
  countWorksInLibrary,
  createJob,
  createLibrary,
  deleteLibrary,
  findJob,
  findLibrary,
  listJobs,
  listLibraries,
  listSkipRecords,
  scanLibrary,
  touchLibraryScan,
  updateJob,
} from "@nekoshelf/core";
import type { AppConfig } from "../config.js";

function libraryDto(db: Db, library: LibraryRow): {
  id: number;
  name: string;
  rootPath: string;
  kind: string;
  workCount: number;
  lastScanAt: string | null;
} {
  return {
    id: library.id,
    name: library.name,
    rootPath: library.root_path,
    kind: library.kind,
    workCount: countWorksInLibrary(db, library.id),
    lastScanAt: library.last_scan_at,
  };
}

function jobDto(job: NonNullable<ReturnType<typeof findJob>>): {
  id: string;
  type: string;
  state: string;
  progress: { done: number; total: number };
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
} {
  let progress = { done: 0, total: 0 };
  try {
    if (job.progress) progress = JSON.parse(job.progress) as { done: number; total: number };
  } catch {
    // 保持默认
  }
  return {
    id: job.id,
    type: job.type,
    state: job.state,
    progress,
    message: job.message,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

/** 单个库同一时间只允许一个扫描任务，避免重复读盘。 */
const runningScans = new Set<number>();

export function registerLibraryRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  app.get("/api/libraries", async () => ({
    items: listLibraries(db).map((library) => libraryDto(db, library)),
  }));

  app.post("/api/libraries", async (request, reply) => {
    const body = request.body as { name?: unknown; rootPath?: unknown; kind?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const rootPath = typeof body?.rootPath === "string" ? body.rootPath.trim() : "";
    if (!name || !rootPath) {
      return reply.code(400).send({ error: { code: "validation_failed", message: "名称与路径必填" } });
    }
    const absolute = resolve(rootPath);
    try {
      const info = await stat(absolute);
      if (!info.isDirectory()) {
        return reply.code(400).send({ error: { code: "validation_failed", message: "路径不是目录" } });
      }
    } catch {
      return reply.code(400).send({ error: { code: "validation_failed", message: "路径不存在或不可读" } });
    }

    const kind =
      body?.kind === "comic" || body?.kind === "video" || body?.kind === "mixed" ? body.kind : "mixed";
    const library = createLibrary(db, { name, rootPath: absolute, kind });
    reply.code(201);
    return { library: libraryDto(db, library) };
  });

  app.delete("/api/libraries/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const library = findLibrary(db, id);
    if (!library) {
      return reply.code(404).send({ error: { code: "not_found", message: "媒体库不存在" } });
    }
    deleteLibrary(db, id);
    reply.code(204);
    return undefined;
  });

  app.post("/api/libraries/:id/scan", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const library = findLibrary(db, id);
    if (!library) {
      return reply.code(404).send({ error: { code: "not_found", message: "媒体库不存在" } });
    }
    if (runningScans.has(id)) {
      return reply.code(409).send({ error: { code: "conflict", message: "该库正在扫描中" } });
    }

    const jobId = randomUUID();
    createJob(db, { id: jobId, type: "scan", libraryId: id });
    runningScans.add(id);

    const scanOptions: ScanOptions = {
      // 网络卷（SMB/NFS）用 SCAN_DELAY_MS 节流：每次目录读取之间休眠，避免把 NAS 打满
      delayMs: config.scanDelayMs,
      readComicInfo: true,
      unmatchedVideoPolicy: config.unmatchedVideoPolicy,
    };

    setImmediate(() => {
      scanLibrary(db, library, { ...scanOptions, jobId })
        .then((summary) => {
          app.log.info({ summary }, "扫描完成");
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          updateJob(db, jobId, { state: "failed", message });
          app.log.error({ error }, "扫描失败");
        })
        .finally(() => {
          runningScans.delete(id);
        });
    });

    reply.code(202);
    return { jobId };
  });

  app.get("/api/jobs/:id", async (request, reply) => {
    const job = findJob(db, (request.params as { id: string }).id);
    if (!job) {
      return reply.code(404).send({ error: { code: "not_found", message: "任务不存在" } });
    }
    return { job: jobDto(job) };
  });

  app.get("/api/jobs", async () => ({ items: listJobs(db).map((job) => jobDto(job)) }));

  app.get("/api/libraries/:id/skips", async (request) => {
    const id = Number((request.params as { id: string }).id);
    return {
      items: listSkipRecords(db, id).map((record) => ({
        path: record.path,
        reason: record.reason,
        at: record.at,
      })),
    };
  });

  // 触及库的 mtime 读取接口，供「重扫」前确认路径仍在线
  app.get("/api/libraries/:id/status", async (request, reply) => {
    const library = findLibrary(db, Number((request.params as { id: string }).id));
    if (!library) {
      return reply.code(404).send({ error: { code: "not_found", message: "媒体库不存在" } });
    }
    let readable = true;
    let error: string | null = null;
    try {
      await stat(library.root_path);
    } catch (statError) {
      readable = false;
      error = statError instanceof Error ? statError.message : String(statError);
    }
    return { readable, error, lastScanAt: library.last_scan_at };
  });
}

export { jobDto, libraryDto, touchLibraryScan };
