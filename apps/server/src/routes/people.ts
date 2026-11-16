/**
 * 作者 / 系列浏览路由。
 *
 * - 作者来自 ComicInfo 的 Writer/Penciller 或目录名前缀 `[作者]`，扫描时写入 people/work_people；
 * - 系列来自 ComicInfo 的 Series，扫描时写入 series/works.series_id；
 * - 列表按作品数降序，支持关键字筛选；详情返回该分类下的作品列表（分页）。
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "@nekoshelf/core";
import {
  findPerson,
  findSeries,
  getProgress,
  listPeople,
  listSeries,
  listWorks,
  workTagsFor,
  type WorkRow,
} from "@nekoshelf/core";

function cardFor(db: Db, work: WorkRow, tags: string[]): Record<string, unknown> {
  const progressRow = getProgress(db, work.id);
  return {
    id: work.id,
    title: work.title,
    titleZh: work.title_zh ?? null,
    kind: work.kind,
    pageCount: work.page_count,
    coverUrl: `/api/works/${work.id}/cover`,
    tags,
    libraryId: work.library_id,
    updatedAt: work.updated_at,
    ...(progressRow && progressRow.page > 0
      ? { progress: { page: progressRow.page, pageCount: progressRow.page_count } }
      : {}),
  };
}

function pageParams(query: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Number(query.page ?? 1);
  const pageSize = Number(query.pageSize ?? 48);
  return {
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    pageSize: Number.isFinite(pageSize) ? Math.min(Math.max(Math.floor(pageSize), 1), 200) : 48,
  };
}

export function registerPeopleRoutes(app: FastifyInstance, db: Db): void {
  /** 作者/画师列表。 */
  app.get("/api/people", async (request) => {
    const query = request.query as { q?: string; limit?: string };
    const limit = Math.min(Number(query.limit ?? 60) || 60, 500);
    return { items: listPeople(db, query.q ?? "", limit) };
  });

  /** 作者详情 + 作品列表。 */
  app.get("/api/people/:id", async (request, reply) => {
    const person = findPerson(db, Number((request.params as { id: string }).id));
    if (!person) {
      return reply.code(404).send({ error: { code: "not_found", message: "作者不存在" } });
    }
    const { page, pageSize } = pageParams(request.query as Record<string, unknown>);
    const result = listWorks(db, { personId: person.id, page, pageSize, sort: "recent" });
    const tags = workTagsFor(db, result.items.map((item) => item.id));
    return {
      person,
      total: result.total,
      page,
      pageSize,
      items: result.items.map((item) => cardFor(db, item, tags.get(item.id) ?? [])),
    };
  });

  /** 系列列表。 */
  app.get("/api/series", async (request) => {
    const query = request.query as { q?: string; limit?: string };
    const limit = Math.min(Number(query.limit ?? 60) || 60, 500);
    return { items: listSeries(db, query.q ?? "", limit) };
  });

  /** 系列详情 + 作品列表。 */
  app.get("/api/series/:id", async (request, reply) => {
    const series = findSeries(db, Number((request.params as { id: string }).id));
    if (!series) {
      return reply.code(404).send({ error: { code: "not_found", message: "系列不存在" } });
    }
    const { page, pageSize } = pageParams(request.query as Record<string, unknown>);
    const result = listWorks(db, { seriesId: series.id, page, pageSize, sort: "recent" });
    const tags = workTagsFor(db, result.items.map((item) => item.id));
    return {
      series,
      total: result.total,
      page,
      pageSize,
      items: result.items.map((item) => cardFor(db, item, tags.get(item.id) ?? [])),
    };
  });
}
