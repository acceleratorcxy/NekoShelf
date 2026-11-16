/**
 * 按文件树浏览（只读）。
 *
 * 用途：用户想看「磁盘上到底是怎么放的」——作品索引之外的真实目录结构。
 * 只读列目录，不写入、不统计全量哈希；路径经 safeJoin 防穿越。
 */
import type { FastifyInstance } from "fastify";
import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { Db, WorkRow } from "@nekoshelf/core";
import { findLibrary, listWorksForLibrary } from "@nekoshelf/core";
import { safeJoin } from "../media.js";

const SKIP_NAMES = new Set([".git", ".DS_Store", "Thumbs.db", "@eaDir", "#recycle"]);

interface TreeEntry {
  name: string;
  type: "dir" | "file";
  size?: number;
  workId?: number;
  workTitle?: string;
  workKind?: string;
  pageCount?: number;
  workCount?: number;
}

function normalizeRel(value: string): string {
  const trimmed = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = trimmed.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error("path traversal");
  return parts.join("/");
}

export function registerTreeRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/libraries/:id/tree", async (request, reply) => {
    const library = findLibrary(db, Number((request.params as { id: string }).id));
    if (!library) {
      return reply.code(404).send({ error: { code: "not_found", message: "媒体库不存在" } });
    }
    const query = request.query as { path?: string };
    let rel: string;
    try {
      rel = normalizeRel(query.path ?? "");
    } catch {
      return reply.code(400).send({ error: { code: "validation_failed", message: "路径非法" } });
    }
    const dir = safeJoin(library.root_path, rel);

    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return reply
        .code(404)
        .send({ error: { code: "tree_path_not_found", message: "目录不存在或不可读" } });
    }

    const works = listWorksForLibrary(db, library.id);
    const byPath = new Map<string, WorkRow>();
    for (const work of works) byPath.set(work.path, work);

    const entries: TreeEntry[] = [];
    for (const dirent of dirents) {
      const name = dirent.name;
      if (SKIP_NAMES.has(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;

      if (dirent.isDirectory()) {
        const direct = byPath.get(childRel);
        let workCount = 0;
        const prefix = `${childRel}/`;
        for (const work of works) {
          if (work.path === childRel) workCount += 1;
          else if (work.path.startsWith(prefix)) workCount += 1;
        }
        entries.push({
          name,
          type: "dir",
          workId: direct?.id,
          workTitle: direct?.title_zh ?? direct?.title,
          workCount,
        });
      } else if (dirent.isFile()) {
        const work = byPath.get(childRel);
        let size: number | undefined;
        try {
          size = (await stat(join(dir, name))).size;
        } catch {
          size = undefined;
        }
        entries.push({
          name,
          type: "file",
          size,
          workId: work?.id,
          workTitle: work ? (work.title_zh ?? work.title) : undefined,
          workKind: work?.kind,
          pageCount: work?.page_count,
        });
      }
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
    });

    return {
      libraryId: library.id,
      libraryName: library.name,
      path: rel,
      parent: rel === "" ? null : rel.split("/").slice(0, -1).join("/"),
      entries,
    };
  });
}
