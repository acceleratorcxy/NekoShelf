import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { Db, WorkRow } from "@nekoshelf/core";
import {
  findLanguageVariant,
  findSeries,
  findWork,
  getProgress,
  listWorkPeople,
  relatedWorkGroups,
  relatedWorks,
  listMergedInto,
  hasPagePairLinks,
  listWorkPageRows,
  findPairOrdinals,
  listWorkChapters,
  listWorkPages,
  listWorks,
  listTags,
  setProgress,
  workTagsFor,
} from "@nekoshelf/core";
import type { AppConfig } from "../config.js";
import {
  contentTypeFor,
  readPageContent,
  resolveCoverIndex,
  pageImageForBrowser,
  thumbnailBuffer,
  videoPosterBuffer,
  workAbsolutePath,
} from "../media.js";

interface WorkCard {
  id: number;
  title: string;
  /** 中文标题（人工或 LLM 翻译），无则为 null。 */
  titleZh: string | null;
  kind: string;
  pageCount: number;
  coverUrl: string | null;
  tags: string[];
  progress?: { page: number; pageCount: number };
  libraryId: number;
  updatedAt: string;
}

function cardFor(db: Db, work: WorkRow, tags: Map<number, string[]>): WorkCard {
  const progressRow = getProgress(db, work.id);
  const card: WorkCard = {
    id: work.id,
    title: work.title,
    titleZh: work.title_zh ?? null,
    kind: work.kind,
    pageCount: work.page_count,
    coverUrl: `/api/works/${work.id}/cover`,
    tags: tags.get(work.id) ?? [],
    libraryId: work.library_id,
    updatedAt: work.updated_at,
  };
  if (progressRow && progressRow.page > 0) {
    card.progress = { page: progressRow.page, pageCount: progressRow.page_count };
  }
  return card;
}

/**
 * 双语包页面切换：`?variant=zh` 时返回该页对应的中文版本页码。
 * 非双语包或不存在对照时原样返回。
 */
function variantPageIndex(
  db: Db,
  work: WorkRow,
  index: number,
  variant: unknown,
): number {
  if (variant !== "zh") return index;
  const page = listWorkPages(db, work.id).find((item) => item.ordinal === index);
  if (!page) return index;
  const alt = findLanguageVariant(db, work.id, page, "zh");
  return alt?.ordinal ?? index;
}

function pageRefs(db: Db, work: WorkRow, limit?: number): Array<{
  index: number;
  width: number | null;
  height: number | null;
  thumbUrl: string;
  imageUrl: string;
  language: string | null;
  pairKey: string | null;
  /** 对照语言版本的页码；无则为 null。 */
  variantIndex: number | null;
}> {
  const pages = listWorkPageRows(db, work.id, limit);
  const pairKeys = [...new Set(pages.map((page) => page.pair_key).filter((key): key is string => !!key))];
  const firstOrdinalByKey = findPairOrdinals(db, work.id, pairKeys);
  return pages.map((page) => {
    const key = page.pair_key;
    const counterpart = key ? firstOrdinalByKey.get(key) : undefined;
    const link = {
      lang: page.lang ?? null,
      pairKey: key ?? null,
      variantOf: counterpart !== undefined && counterpart !== page.ordinal ? counterpart : null,
    };
    return {
      index: page.ordinal,
      width: page.width,
      height: page.height,
      thumbUrl: `/api/works/${work.id}/pages/${page.ordinal}/thumb`,
      imageUrl: `/api/works/${work.id}/pages/${page.ordinal}/image`,
      language: link?.lang ?? null,
      pairKey: link?.pairKey ?? null,
      variantIndex: link?.variantOf ?? null,
    };
  });
}

async function sendFileRange(
  reply: FastifyReply,
  absolutePath: string,
  size: number,
  contentType: string,
): Promise<void> {
  reply.header("accept-ranges", "bytes");
  const total = size;
  if (total === 0) {
    reply.code(404).send({ error: { code: "not_found", message: "文件为空" } });
    return;
  }
  reply.header("content-type", contentType);
  reply.header("content-length", String(total));
  reply.send(createReadStream(absolutePath));
}

export function registerWorkRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  app.get("/api/tags", async (request) => {
    const query = request.query as { q?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 200);
    const items = listTags(db, query.q?.trim() || undefined, limit).map((tag) => ({
      id: tag.id,
      namespace: tag.namespace,
      name: tag.name,
      count: tag.count,
    }));
    return { items };
  });

  app.get("/api/works", async (request) => {
    const query = request.query as {
      q?: string;
      libraryId?: string;
      kind?: string;
      sort?: string;
      page?: string;
      pageSize?: string;
    };
    const { items, total } = listWorks(db, {
      q: query.q,
      libraryId: query.libraryId ? Number(query.libraryId) : undefined,
      kind:
        query.kind === "comic" || query.kind === "image-set" || query.kind === "video"
          ? query.kind
          : undefined,
      sort: query.sort === "title" || query.sort === "rating" ? query.sort : "recent",
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 48,
    });
    const tags = workTagsFor(
      db,
      items.map((work) => work.id),
    );
    return {
      items: items.map((work) => cardFor(db, work, tags)),
      total,
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 48,
    };
  });

  app.get("/api/works/:id", async (request, reply) => {
    const query = request.query as { pages?: string };
    const preview = query.pages === "preview";
    const work = findWork(db, Number((request.params as { id: string }).id));
    if (!work) {
      return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    }
    const tags = workTagsFor(db, [work.id]);
    const progressRow = getProgress(db, work.id);
    return {
      work: {
        ...cardFor(db, work, tags),
        sourceKind: work.source_kind,
        gid: work.gid,
        hasComicInfo: work.has_comicinfo === 1,
        rating: work.rating,
        path: work.path,
        /** 合并：本作品已合并的副本数量与指向。 */
        mergedCount: listMergedInto(db, work.id).length,
        mergedIntoId: work.merged_into ?? null,
        /** 作者/画师（ComicInfo Writer/Penciller 或目录名前缀）。 */
        authors: listWorkPeople(db, work.id),
        /** 所属系列名，未归属为 null。 */
        series: work.series_id ? (findSeries(db, work.series_id)?.name ?? null) : null,
        seriesId: work.series_id ?? null,
      },
      editions: [],
      pages: preview ? pageRefs(db, work, 24) : pageRefs(db, work),
      pageCount: work.page_count,
      /** 章节（多话漫画/杂图合集/剧集式视频）；单文件作品为空数组。 */
      chapters: listWorkChapters(db, work.id).map((chapter) => ({
        index: chapter.sort,
        title: chapter.title,
        startPage: chapter.start_page,
        pageCount: chapter.page_count,
      })),
      coverIndex: work.kind === "video" ? null : resolveCoverIndex(db, work),
      /** 双语包：页面对照语言版本存在。 */
      dualLanguage: hasPagePairLinks(db, work.id),
      progress: progressRow
        ? { page: progressRow.page, pageCount: progressRow.page_count }
        : null,
    };
  });

  /** 关联作品推荐：同系列 > 同作者/画师 > 同标签。 */
  app.get("/api/works/:id/related", async (request, reply) => {
    const work = findWork(db, Number((request.params as { id: string }).id));
    if (!work) {
      return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    }
    const groups = relatedWorkGroups(db, work.id);
    const toCards = (rows: typeof groups.series) =>
      rows.map((item) => cardFor(db, item, workTagsFor(db, [item.id])));
    const series = toCards(groups.series);
    const authors = toCards(groups.authors);
    const tags = toCards(groups.tags);
    const name = toCards(groups.name);
    const seen = new Set<number>();
    const items = [...series, ...authors, ...tags, ...name].filter((card) => {
      if (seen.has(Number(card.id))) return false;
      seen.add(Number(card.id));
      return true;
    });
    return { items, groups: { series, authors, tags, name } };
  });

  app.get("/api/works/:id/cover", async (request, reply) => {
    const work = findWork(db, Number((request.params as { id: string }).id));
    if (!work) {
      return reply.code(404).send({ error: { code: "not_found", message: "无封面" } });
    }
    if (work.kind === "video") {
      const chapters = listWorkChapters(db, work.id);
      const rawChapter = Number((request.query as { chapter?: string }).chapter ?? "0");
      const chapterIndex = chapters.findIndex((item) =>
        item.sort === (Number.isFinite(rawChapter) ? Math.floor(rawChapter) : 0),
      );
      const target = chapterIndex >= 0 ? chapters[chapterIndex]! : chapters[0];
      const poster = await videoPosterBuffer(
        db,
        work,
        config.cacheDir,
        640,
        target ? join(workAbsolutePath(db, work), target.rel_path) : undefined,
      );
      if (!poster) {
        return reply.code(404).send({ error: { code: "not_found", message: "无法生成视频封面" } });
      }
      reply.header("content-type", "image/jpeg");
      reply.header("cache-control", "private, max-age=600");
      return reply.send(poster);
    }
    const coverIndex = resolveCoverIndex(db, work);
    if (coverIndex === null) {
      return reply.code(404).send({ error: { code: "not_found", message: "无封面" } });
    }
    const cover = await thumbnailBuffer(db, work, coverIndex, config.cacheDir, 480);
    reply.header("content-type", cover.contentType);
    reply.header("cache-control", "private, max-age=600");
    return reply.send(cover.buffer);
  });

  /** 单章详情（合集/多话作品的某一话），供章节独立详情页使用。 */
  app.get("/api/works/:id/chapters/:index", async (request, reply) => {
    const work = findWork(db, Number((request.params as { id: string }).id));
    if (!work) {
      return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    }
    const chapters = listWorkChapters(db, work.id);
    const index = Number((request.params as { index: string }).index);
    const position = chapters.findIndex((item) => item.sort === index);
    const chapter = position >= 0 ? chapters[position] : undefined;
    if (!chapter) {
      return reply
        .code(404)
        .send({ error: { code: "chapter_not_found", message: "章节不存在" } });
    }
    const startPage = chapter.start_page;
    const mediaBase = `/api/works/${work.id}`;
    return {
      work: {
        id: work.id,
        title: work.title,
        titleZh: work.title_zh,
        kind: work.kind,
        pageCount: work.page_count,
        authors: listWorkPeople(db, work.id),
        series: work.series_id ? (findSeries(db, work.series_id)?.name ?? null) : null,
      },
      chapter: {
        index: chapter.sort,
        title: chapter.title,
        startPage,
        pageCount: chapter.page_count,
      },
      prevIndex: position > 0 ? chapters[position - 1]!.sort : null,
      nextIndex: position < chapters.length - 1 ? chapters[position + 1]!.sort : null,
      coverThumbUrl:
        work.kind === "video"
          ? `${mediaBase}/cover?chapter=${chapter.sort}`
          : `${mediaBase}/pages/${startPage}/thumb`,
      coverImageUrl:
        work.kind === "video"
          ? `${mediaBase}/cover?chapter=${chapter.sort}`
          : `${mediaBase}/pages/${startPage}/image`,
    };
  });

  app.get("/api/works/:id/pages/:index/thumb", async (request, reply) => {
    const params = request.params as { id: string; index: string };
    const work = findWork(db, Number(params.id));
    if (!work || work.kind === "video") {
      return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    }
    const pageIndex = variantPageIndex(
      db,
      work,
      Number(params.index),
      (request.query as { variant?: string }).variant,
    );
    // 两级缩略图，宽度可调（80–800，默认 320）
    const widthParam = Number((request.query as { w?: string }).w);
    const width = Number.isFinite(widthParam)
      ? Math.min(Math.max(Math.round(widthParam), 80), 800)
      : 320;
    const thumb = await thumbnailBuffer(db, work, pageIndex, config.cacheDir, width);
    reply.header("content-type", thumb.contentType);
    reply.header("cache-control", "private, max-age=600");
    return reply.send(thumb.buffer);
  });

  app.get("/api/works/:id/pages/:index/image", async (request, reply) => {
    const params = request.params as { id: string; index: string };
    const work = findWork(db, Number(params.id));
    if (!work || work.kind === "video") {
      return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    }
    const pageIndex = variantPageIndex(
      db,
      work,
      Number(params.index),
      (request.query as { variant?: string }).variant,
    );
    const content = await pageImageForBrowser(await readPageContent(db, work, pageIndex, config.cacheDir));
    reply.header("content-type", content.contentType);
    reply.header("cache-control", "private, max-age=3600");
    return reply.send(content.buffer);
  });

  /** 视频作品原文件流（支持 Range）。 */
  app.get("/api/works/:id/video", async (request, reply) => {
    const work = findWork(db, Number((request.params as { id: string }).id));
    if (!work || work.kind !== "video") {
      return reply.code(404).send({ error: { code: "not_found", message: "视频不存在" } });
    }
    const chapters = listWorkChapters(db, work.id);
    let path = workAbsolutePath(db, work);
    if (chapters.length > 0) {
      const raw = Number((request.query as { chapter?: string }).chapter ?? "0");
      const index = Number.isFinite(raw)
        ? Math.min(Math.max(Math.floor(raw), 0), chapters.length - 1)
        : 0;
      path = join(path, chapters[index]?.rel_path ?? chapters[0]!.rel_path);
    }
    const info = await stat(path);
    const contentType = contentTypeFor(path);

    const range = request.headers.range;
    if (!range) {
      await sendFileRange(reply, path, info.size, contentType);
      return undefined;
    }

    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) {
      return reply.code(416).send({ error: { code: "validation_failed", message: "Range 无效" } });
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : info.size - 1;
    if (start >= info.size || end >= info.size || start > end) {
      reply.header("content-range", `bytes */${info.size}`);
      return reply.code(416).send({ error: { code: "validation_failed", message: "Range 越界" } });
    }
    reply.code(206);
    reply.header("content-range", `bytes ${start}-${end}/${info.size}`);
    reply.header("accept-ranges", "bytes");
    reply.header("content-type", contentType);
    reply.header("content-length", String(end - start + 1));
    return reply.send(createReadStream(path, { start, end }));
  });

  app.put("/api/works/:id/progress", async (request, reply) => {
    const work = findWork(db, Number((request.params as { id: string }).id));
    if (!work) {
      return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    }
    const body = request.body as { page?: unknown } | null;
    const page = typeof body?.page === "number" ? Math.floor(body.page) : Number.NaN;
    if (!Number.isFinite(page) || page < 0 || page > work.page_count) {
      return reply.code(400).send({ error: { code: "validation_failed", message: "页码非法" } });
    }
    setProgress(db, work.id, page, work.page_count);
    reply.code(204);
    return undefined;
  });
}
