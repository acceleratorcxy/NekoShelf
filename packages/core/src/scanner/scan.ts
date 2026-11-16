import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db/database.js";
import {
  addSkipRecord,
  ensureSeries,
  setWorkPeople,
  setWorkSeries,
  createJob,
  listLibraries,
  setWorkTagsByNamespace,
  touchLibraryScan,
  normalizeTitleKey,
  updateJob,
  upsertWork,
  replaceWorkChapters,
  listWorksNeedingSeries,
  type UpsertWorkInput,
} from "../db/repos.js";
import type { LibraryRow } from "../db/types.js";
import { listArchiveEntries } from "./archive.js";
import { annotatePages } from "./pairing.js";
import { discoverWorks, type DiscoverOptions, type DiscoveredWork } from "./discover.js";
import { comicInfoToTags, parseComicInfo, type ComicInfoMeta } from "./comicinfo.js";
import { deriveSeriesTitle, normalizeSeriesKey } from "./title.js";

export interface ScanOptions extends DiscoverOptions {
  /** 读取 ComicInfo.xml 覆盖标题（默认开；网络卷可关）。 */
  readComicInfo?: boolean;
  /** 读取 zip 中央目录得到页数（默认开）。 */
  readArchivePages?: boolean;
  /** 任务 id，用于进度上报；不传则内部创建一个。 */
  jobId?: string;
}

export interface ScanSummary {
  jobId: string;
  works: number;
  /** 本次实际遍历的目录数（诊断用：0 作品时能看出是不是根本没进目录）。 */
  directories: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

const PAGE_LIMIT = 5_000;
const COMICINFO_MAX_BYTES = 256 * 1024;

interface WorkMeta {
  title?: string;
  gid?: number | null;
  pages?: Array<{
    name: string;
    sizeBytes?: number | null;
    lang?: string | null;
    pairKey?: string | null;
  }>;
  pageCount: number;
  /** ComicInfo 里提取的标签（默认写入索引，供本地元数据搜索）。 */
  tags?: Array<{ namespace: string; name: string }>;
  /** 作者/画师（ComicInfo 的 Writer/Penciller 或目录名前缀）。 */
  people?: Array<{ role: "artist" | "writer" | "group" | "series"; name: string }>;
  /** 系列名（ComicInfo 的 Series）。 */
  seriesName?: string;
  /** 非空表示该作品不应入库（记录为 skip）。 */
  skipReason?: string;
}

async function readComicInfo(
  work: DiscoveredWork,
): Promise<{
  title?: string;
  tags: Array<{ namespace: string; name: string }>;
  meta?: ComicInfoMeta;
}> {
  if (!work.hasComicInfo) return { tags: [] };
  const path = work.sourceKind === "directory" ? join(work.absolutePath, "ComicInfo.xml") : null;
  if (!path) return { tags: [] };
  try {
    const buffer = await readFile(path);
    if (buffer.byteLength > COMICINFO_MAX_BYTES) return { tags: [] };
    const meta = parseComicInfo(buffer.toString("utf8"));
    return { title: meta.title, tags: comicInfoToTags(meta), meta };
  } catch {
    return { tags: [] };
  }
}

/** 从 ComicInfo 的 Writer/Penciller 提取作者与画师（Writer 在 E-H 语境里是社团/作者）。 */
function peopleFromMeta(meta: ComicInfoMeta | undefined): Array<{
  role: "artist" | "writer";
  name: string;
}> {
  const people: Array<{ role: "artist" | "writer"; name: string }> = [];
  const writer = meta?.writer?.trim();
  const penciller = meta?.penciller?.trim();
  if (writer && writer.toLowerCase() !== "unknown") people.push({ role: "writer", name: writer });
  if (penciller && penciller.toLowerCase() !== "unknown" && penciller !== writer) {
    people.push({ role: "artist", name: penciller });
  }
  return people;
}

/** 目录名前缀 `[作者] 作品名` 的作者兜底。 */
function authorFromDirName(relativePath: string): string | undefined {
  const name = relativePath.split("/").pop() ?? "";
  const match = /^\[([^\]]{1,60})\]/.exec(name);
  return match ? match[1]!.trim() : undefined;
}

/**
 * 从路径推导作者（按目录层级）：
 * - `真人合集杂图/<作者>/...` → <作者>
 * - `杂/作者合集/<作者>/...` → <作者>
 * - `本子/作者合集/C####-[作者 (社团)]/...` → 括号里的作者
 * - `本子/tmp/[作者]/...` → 去括号的作者
 */
function inferPathAuthors(relativePath: string): string[] {
  const parts = relativePath.split("/");
  const clean = (value: string): string =>
    value
      .replace(/^\[([^\]]+)\]\s*/, "$1")
      .replace(/^C\d+-/, "")
      .trim();
  const top = parts[0] ?? "";
  if (top === "真人合集杂图" && parts[1]) return [clean(parts[1])];
  if (top === "杂" && parts[1] === "作者合集" && parts[2]) return [clean(parts[2])];
  if (top === "本子" && parts[1] === "作者合集" && parts[2]) {
    const match = /\[([^\]]+)\]/.exec(parts[2]);
    return match?.[1] ? [match[1].trim()] : [];
  }
  if (top === "本子" && parts[1] === "tmp" && parts[2]) return [clean(parts[2])];
  return [];
}

async function collectMeta(work: DiscoveredWork, options: ScanOptions): Promise<WorkMeta> {
  if (work.sourceKind === "directory") {
    const annotated = annotatePages(work.files.slice(0, PAGE_LIMIT).map((name) => ({ name })));
    const comicInfo = await readComicInfo(work);
    const people = peopleFromMeta(comicInfo.meta);
    const pathAuthors = inferPathAuthors(work.relativePath);
    if (pathAuthors.length > 0) {
      const seen = new Set(people.map((person) => person.name.toLowerCase()));
      for (const author of pathAuthors) {
        if (seen.has(author.toLowerCase())) continue;
        seen.add(author.toLowerCase());
        people.push({ role: "writer", name: author });
      }
    } else if (people.length === 0) {
      const author = authorFromDirName(work.relativePath);
      if (author) people.push({ role: "writer", name: author });
    }
    const seriesName = comicInfo.meta?.series?.trim();
    return {
      title: comicInfo.title,
      tags: comicInfo.tags,
      people,
      seriesName: seriesName && seriesName.length > 0 ? seriesName : undefined,
      pageCount: annotated.length,
      pages: annotated.map((page) => ({
        name: page.name,
        lang: page.lang,
        pairKey: page.pairKey,
      })),
    };
  }

  if (work.sourceKind === "video") {
    return { pageCount: 1 };
  }

  // archive：zip 读中央目录；7z/rar 走 7zz（只读条目元数据，不解压）
  if (options.readArchivePages !== false) {
    const listing = await listArchiveEntries(work.absolutePath, { maxEntries: PAGE_LIMIT * 4 });
    if (listing.error) {
      return { pageCount: 0, skipReason: `无法读取压缩包：${listing.error}` };
    }
    if (listing.pages.length === 0) {
      return { pageCount: 0, skipReason: "压缩包内未找到可阅读图片页" };
    }
    // 游戏/资源包特征：条目很多但图片占比很低（实测 GAL 游戏包会被当成数千页漫画）。
    const total = Math.max(listing.totalEntries, listing.pages.length);
    if (total >= 500 && listing.pages.length / total < 0.5) {
      return {
        pageCount: 0,
        skipReason: `压缩包内图片占比过低（${listing.pages.length}/${total}），疑似游戏/资源包`,
      };
    }
    const annotated = annotatePages(listing.pages.slice(0, PAGE_LIMIT));
    return {
      pageCount: annotated.length,
      pages: annotated.map((entry) => ({
        name: entry.name,
        sizeBytes: entry.size ?? null,
        lang: entry.lang,
        pairKey: entry.pairKey,
      })),
    };
  }

  return { pageCount: 0 };
}

async function fileTimes(
  absolutePath: string,
): Promise<{ mtime: number | null; sizeBytes: number | null }> {
  try {
    const info = await stat(absolutePath);
    return { mtime: Math.floor(info.mtimeMs), sizeBytes: info.size };
  } catch {
    return { mtime: null, sizeBytes: null };
  }
}

/**
 * 扫描一个媒体库：只读、顺序遍历、可中断。失败的作品只记录 skip，不中断整次扫描。
 */
export async function scanLibrary(
  db: Db,
  library: LibraryRow,
  options: ScanOptions = {},
): Promise<ScanSummary> {
  const started = Date.now();
  const jobId = options.jobId ?? `scan-${library.id}-${started}`;
  if (!options.jobId) createJob(db, { id: jobId, type: "scan", libraryId: library.id });

  updateJob(db, jobId, { state: "running", progress: { done: 0, total: 0 } });

  let works = 0;
  let directories = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let errors = 0;

  /** 真实跳过（广告/游戏/压缩包异常/读取失败等）；结构提示走 onNote，不计入。 */
  const skipCategories = new Map<string, number>();
  const recordSkip = (path: string, reason: string): void => {
    skipped += 1;
    const category = categorizeSkip(reason);
    skipCategories.set(category, (skipCategories.get(category) ?? 0) + 1);
    addSkipRecord(db, library.id, path, reason);
    options.onSkip?.({ path, reason });
  };

  try {
    for await (const work of discoverWorks(library.root_path, {
      ...options,
      onProgress: (state) => {
        directories = state.directories;
        options.onProgress?.(state);
      },
      onSkip: (skip) => recordSkip(skip.path, skip.reason),
      onNote: (note) => options.onNote?.(note),
    })) {
      works += 1;
      try {
        const meta = await collectMeta(work, options);
        if (meta.skipReason) {
          works -= 1;
          recordSkip(work.relativePath, meta.skipReason);
          continue;
        }
        // 视频作品：一话算一页（进度按话），页数 = 章节数。
        if (work.kind === "video") {
          meta.pageCount = Math.max(work.chapters?.length ?? 1, 1);
        }
        const { mtime, sizeBytes } = await fileTimes(work.absolutePath);
        const input: UpsertWorkInput = {
          libraryId: library.id,
          relativePath: work.relativePath,
          title: meta.title ?? work.title,
          kind: work.kind,
          sourceKind: work.sourceKind,
          gid: work.gid,
          pageCount: meta.pageCount,
          mtime,
          sizeBytes,
          fingerprint: mtime !== null && sizeBytes !== null ? `${mtime}:${sizeBytes}` : null,
          hasComicInfo: work.hasComicInfo,
          dupKey: normalizeTitleKey(meta.title ?? work.title),
          pages: meta.pages,
        };
        const result = upsertWork(db, input);
        if (meta.tags && meta.tags.length > 0) {
          const byNamespace = new Map<string, string[]>();
          for (const tag of meta.tags) {
            const list = byNamespace.get(tag.namespace) ?? [];
            list.push(tag.name);
            byNamespace.set(tag.namespace, list);
          }
          for (const [namespace, names] of byNamespace) {
            setWorkTagsByNamespace(db, result.id, namespace, names);
          }
        }
        if (work.chapters && work.chapters.length > 0) {
          if (work.kind === "video") {
            // 视频合集：一话 = 一页（进度按话记录），rel_path 指向该话的视频文件。
            const chapters = work.chapters.map((chapter, chapterIndex) => ({
              title: chapter.title,
              relPath: chapter.videos[0] ?? chapter.title,
              startPage: chapterIndex + 1,
              pageCount: 1,
            }));
            replaceWorkChapters(db, result.id, chapters);
          } else {
            let startPage = 1;
            const chapters = work.chapters.map((chapter) => {
              const pageCount = Math.min(
                chapter.files.length,
                Math.max(meta.pageCount - startPage + 1, 0),
              );
              const entry = {
                title: chapter.title,
                relPath: chapter.videos[0] ?? chapter.title,
                startPage,
                pageCount: Math.max(pageCount, 0),
              };
              startPage += chapter.files.length;
              return entry;
            });
            replaceWorkChapters(db, result.id, chapters);
          }
        }
        if (result.action !== "unchanged") {
          if (meta.seriesName) setWorkSeries(db, result.id, ensureSeries(db, meta.seriesName));
          setWorkPeople(db, result.id, meta.people ?? []);
        }
        if (result.action === "created") created += 1;
        else if (result.action === "updated") updated += 1;
        else unchanged += 1;
        updateJob(db, jobId, {
          progress: { done: works, total: 0 },
          message: work.relativePath,
        });
      } catch (error) {
        errors += 1;
        const reason = error instanceof Error ? error.message : String(error);
        recordSkip(work.relativePath, `索引失败：${reason}`);
      }
    }

    // 系列归并：同作者 + 相似标题（去掉卷/册/汉化组等标记后相同）且 ≥2 部 → 归为同一系列。
    assignSeriesHeuristically(db, library.id);

    // 零作品时给出可自查的诊断记录（P0-1 的体验问题）。
    if (works === 0) {
      recordSkip(
        ".",
        `本次扫描遍历 ${directories} 个目录但未产出作品：请确认库根目录只放文件夹、子目录内含 3 张以上图片或压缩包`,
      );
    }
    touchLibraryScan(db, library.id);
    updateJob(db, jobId, {
      state: "done",
      progress: { done: works, total: works },
      message:
        `完成：扫描 ${directories} 个目录 / ${created} 新增 / ${updated} 更新 / ` +
        `${unchanged} 未变 / ${skipped} 跳过${formatSkipBreakdown(skipCategories)} / ${errors} 失败`,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updateJob(db, jobId, { state: "failed", message: reason });
    throw error;
  }

  return {
    jobId,
    works,
    directories,
    created,
    updated,
    unchanged,
    skipped,
    errors,
    durationMs: Date.now() - started,
  };
}

/** 扫描所有库（启动时后台任务用）。 */
export async function scanAllLibraries(db: Db, options: ScanOptions = {}): Promise<ScanSummary[]> {
  const summaries: ScanSummary[] = [];
  for (const library of listLibraries(db)) {
    summaries.push(await scanLibrary(db, library, options));
  }
  return summaries;
}



/** 把跳过原因归到便于统计的类别。 */
function categorizeSkip(reason: string): string {
  if (reason.includes("广告") || reason.includes("干扰")) return "广告/干扰";
  if (reason.includes("游戏") || reason.includes("程序目录")) return "游戏/程序目录";
  if (reason.includes("压缩包")) return "压缩包异常";
  if (reason.includes("无法读取") || reason.includes("索引失败")) return "读取/索引失败";
  if (reason.includes("超过上限") || reason.includes("深度超过") || reason.includes("条目数")) return "超出限制";
  return "其他";
}

/** 形如「（广告/干扰 12、游戏/程序目录 3）」；为空返回空串。 */
function formatSkipBreakdown(categories: Map<string, number>): string {
  if (categories.size === 0) return "";
  const parts = [...categories.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`);
  return `（${parts.join("、")}）`;
}

/** 占位标题不参与系列归并（同一作者的 notext 往往是不同系列）。 */
const PLACEHOLDER_TITLE = /^(notext|no ?title|untitled|无题|未命名|cover|img\d*|[0-9]+)$/i;

/** 扫描结束后按「同作者 + 相似标题」做一次系列归并；返回被归入系列的作品数。 */
export function assignSeriesHeuristically(db: Db, libraryId: number): number {
  const rows = listWorksNeedingSeries(db, libraryId);
  const groups = new Map<string, { title: string; ids: number[] }>();
  for (const row of rows) {
    const author = row.authors[0];
    if (!author) continue;
    const title = row.title.trim();
    if (PLACEHOLDER_TITLE.test(title)) continue;
    const key = normalizeSeriesKey(title);
    if (key.length < 3 || key.length > 90) continue;
    if (PLACEHOLDER_TITLE.test(key)) continue;
    const groupKey = `${author.toLowerCase()}|${key}`;
    const group = groups.get(groupKey) ?? { title: deriveSeriesTitle(title), ids: [] };
    group.ids.push(row.id);
    groups.set(groupKey, group);
  }
  let assigned = 0;
  for (const group of groups.values()) {
    if (group.ids.length < 2) continue;
    const seriesId = ensureSeries(db, group.title.length > 0 ? group.title : "未命名系列");
    for (const id of group.ids) {
      setWorkSeries(db, id, seriesId);
      assigned += 1;
    }
  }
  return assigned;
}
