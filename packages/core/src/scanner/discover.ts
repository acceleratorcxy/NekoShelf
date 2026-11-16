import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkKind } from "../db/types.js";
import { parseAvFilename } from "../parsers/avCode.js";
import { naturalCompare } from "../parsers/natural.js";
import {
  isArchiveFile,
  isIgnoredDirectory,
  isImageFile,
  isJunkFile,
  isThumbnailFile,
  isVideoFile,
} from "./rules.js";
import { deriveGidFromName, deriveTitleFromName } from "./title.js";

export type DiscoveredSource = "directory" | "archive" | "video";

export interface DiscoveredChapter {
  /** 分部/套图标题（子目录名）。 */
  title: string;
  /** 相对作品目录的图片文件名（已自然序）。 */
  files: string[];
  /** 相对作品目录的视频文件名（已自然序）。 */
  videos: string[];
}

export interface DiscoveredWork {
  kind: WorkKind;
  sourceKind: DiscoveredSource;
  /** 相对库根目录的路径，统一用 `/` 分隔。 */
  relativePath: string;
  absolutePath: string;
  title: string;
  gid: number | null;
  /** 目录作品的图片文件名（自然序）；压缩包/视频作品为空。 */
  files: string[];
  /** 图集合集的分部列表（按子目录/日期分组）；非合集为空。 */
  chapters?: DiscoveredChapter[];
  /** 视频作品的番号（如 `XYZ-456`）。 */
  code?: string;
  hasComicInfo: boolean;
}

/** 广告/干扰类视频：文件名命中这些特征时不建作品（无论策略）。 */
function isLikelyAdVideo(name: string): boolean {
  return /地址发布器|最新地址|发布页|加群|微信|qq群|客服|直播|推广|广告|扫码|永久域名|app下载|\.apk$/i.test(
    name,
  );
}

/** 同一目录下的视频 → 视频作品：同番号归并主片、多集合并为多章、无番号按策略处理。 */
async function planVideoWorks(input: {
  current: { abs: string; rel: string };
  videos: string[];
  policy: "skip" | "as-work";
  onNote?: (note: DiscoverSkip) => void;
  onSkip?: (skip: DiscoverSkip) => void;
}): Promise<DiscoveredWork[]> {
  const { current, videos, policy } = input;
  const result: DiscoveredWork[] = [];

  const episodes = detectVideoEpisodes(videos);
  if (episodes) {
    result.push({
      kind: "video",
      sourceKind: "video",
      relativePath: current.rel || ".",
      absolutePath: current.abs,
      title: deriveTitleFromName(current.rel.split("/").pop() ?? current.rel),
      gid: null,
      files: [],
      chapters: episodes.map((name) => ({
        title: name.replace(/\.[^.]+$/, ""),
        files: [],
        videos: [name],
      })),
      hasComicInfo: false,
    });
    input.onNote?.({
      path: current.rel || ".",
      reason: `按剧集处理（${episodes.length} 集，同一目录）`,
    });
    return result;
  }

  const groups = new Map<string, Array<{ name: string; size: number }>>();
  const unmatched: string[] = [];
  for (const name of videos) {
    const parsed = parseAvFilename(name);
    if (!parsed) {
      unmatched.push(name);
      continue;
    }
    let size = 0;
    try {
      size = (await stat(join(current.abs, name))).size;
    } catch {
      size = 0;
    }
    const list = groups.get(parsed.code) ?? [];
    list.push({ name, size });
    groups.set(parsed.code, list);
  }

  const unmatchedVideos: string[] = [];
  for (const name of unmatched) {
    const relative = joinRelative(current.rel, name);
    if (isLikelyAdVideo(name)) {
      input.onSkip?.({ path: relative, reason: "视频文件名命中广告特征，判定为广告/干扰" });
      continue;
    }
    if (policy === "as-work") {
      unmatchedVideos.push(name);
      continue;
    }
    input.onSkip?.({ path: relative, reason: "视频无标准番号（UNMATCHED_VIDEO_POLICY=as-work 可入库）" });
  }

  // 目录即整理：同一目录下的多个无番号视频合并成一个作品（每集一个分部），
  // 不再把每个文件都拆成独立作品。
  if (unmatchedVideos.length === 1) {
    const name = unmatchedVideos[0]!;
    result.push({
      kind: "video",
      sourceKind: "video",
      relativePath: joinRelative(current.rel, name),
      absolutePath: join(current.abs, name),
      title: deriveTitleFromName(name.replace(/\.[^.]+$/, "")),
      gid: null,
      files: [],
      hasComicInfo: false,
    });
  } else if (unmatchedVideos.length > 1) {
    const sorted = [...unmatchedVideos].sort(naturalCompare);
    result.push({
      kind: "video",
      sourceKind: "video",
      relativePath: current.rel || ".",
      absolutePath: current.abs,
      title: deriveTitleFromName(current.rel.split("/").pop() ?? current.rel),
      gid: null,
      files: [],
      chapters: sorted.map((name) => ({
        title: name.replace(/\.[^.]+$/, ""),
        files: [],
        videos: [name],
      })),
      hasComicInfo: false,
    });
    input.onNote?.({
      path: current.rel || ".",
      reason: `同目录 ${sorted.length} 个无番号视频合并为一个作品`,
    });
  }

  for (const [code, list] of groups) {
    list.sort((a, b) => b.size - a.size || naturalCompare(a.name, b.name));
    const main = list[0]!;
    result.push({
      kind: "video",
      sourceKind: "video",
      relativePath: joinRelative(current.rel, main.name),
      absolutePath: join(current.abs, main.name),
      title: code,
      gid: null,
      files: [],
      code,
      hasComicInfo: false,
    });
    if (list.length > 1) {
      input.onNote?.({
        path: joinRelative(current.rel, main.name),
        reason: `同番号 ${code} 共 ${list.length} 个文件，仅主片入库（其余视为版本/广告）`,
      });
    }
  }
  return result;
}

export interface DiscoverSkip {
  path: string;
  reason: string;
}

export interface DiscoverOptions {
  /** 最大目录深度，默认 12。 */
  maxDepth?: number;
  /** 最多读取的文件系统条目数，默认 30 万，防止误挂 `/`。 */
  maxEntries?: number;
  /**
   * 每处理一个目录后的休眠毫秒，默认 0。
   * 网络卷（SMB/NFS）必须设置 ≥1ms：实测 NAS 上并发遍历会把 SMB 打满、拖慢其它设备。
   */
  delayMs?: number;
  signal?: AbortSignal;
  /**
   * 未识别番号的视频处理策略。
   * - `skip`（默认）：判定为广告/干扰文件，不建作品；
   * - `as-work`：仍作为 video 作品入库（标题取文件名），适合真人/3D/无番号视频库。
   */
  unmatchedVideoPolicy?: "skip" | "as-work";
  onSkip?: (skip: DiscoverSkip) => void;
  /** 结构提示（容器目录继续下钻、图集合并、版本组等）：不是跳过，不计入跳过数。 */
  onNote?: (note: DiscoverSkip) => void;
  onProgress?: (state: { directories: number; works: number; current: string }) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinRelative(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}/${name}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 疑似程序/游戏目录（GAL 等）：含 exe/dll/pak 时整目录跳过。 */
function looksLikeGameDirectory(names: readonly string[]): boolean {
  return names.some((name) => /\.(exe|dll|pak|swf)$/i.test(name));
}

/**
 * 只读遍历库目录，产出「作品」——不改名、不解压、不读文件内容（zip 中央目录除外）。
 *
 * 判定顺序：游戏目录跳过 → 含压缩包则为压缩包作品 → 含视频则为视频作品（按番号归并主片）
 * → 含图片则为图片/漫画作品 → 否则递归子目录。
 */
/** 同一目录下多集视频的识别：全部同番号带分部标记，或全部是卷/话式命名。 */
function detectVideoEpisodes(videos: readonly string[]): string[] | null {
  if (videos.length < 2) return null;
  const codes = new Set<string>();
  let allHaveCode = true;
  for (const name of videos) {
    const parsed = parseAvFilename(name);
    if (!parsed) {
      allHaveCode = false;
      continue;
    }
    codes.add(parsed.code);
  }
  const sorted = [...videos].sort(naturalCompare);
  const allVolumeLike = videos.every((name) => isVolumeLikeName(name));
  const hasPartMarker = videos.some((name) =>
    /(?:cd|disc|part|前篇|后篇|上|下|第\s*\d+\s*[话話集]|[-_ ]\d{1,3})$/i.test(name.replace(/\.[^.]+$/, "")),
  );
  if (allHaveCode && codes.size === 1 && (hasPartMarker || allVolumeLike)) return sorted;
  if (allHaveCode && codes.size > 1 && allVolumeLike) return sorted;
  if (!allHaveCode && allVolumeLike) return sorted;
  return null;
}

export async function* discoverWorks(
  root: string,
  options: DiscoverOptions = {},
): AsyncGenerator<DiscoveredWork> {
  const maxDepth = options.maxDepth ?? 12;
  const maxEntries = options.maxEntries ?? 300_000;
  const delayMs = options.delayMs ?? 0;

  let entriesSeen = 0;
  let directories = 0;
  let works = 0;
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: root, rel: "", depth: 0 },
  ];

  while (queue.length > 0) {
    if (options.signal?.aborted) return;
    const current = queue.shift()!;

    let dirents;
    try {
      dirents = await readdir(current.abs, { withFileTypes: true });
    } catch (error) {
      options.onSkip?.({ path: current.rel || ".", reason: `无法读取目录：${errorMessage(error)}` });
      continue;
    }

    directories += 1;
    entriesSeen += dirents.length;
    if (entriesSeen > maxEntries) {
      options.onSkip?.({
        path: current.rel || ".",
        reason: `条目数超过上限 ${maxEntries}，已停止（避免误挂大目录）`,
      });
      return;
    }
    options.onProgress?.({ directories, works, current: current.rel || "." });

    if (delayMs > 0) await sleep(delayMs);

    const files: string[] = [];
    const subdirs: string[] = [];
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue; // 不跟随符号链接，避免环与越界
      if (dirent.isDirectory()) {
        if (!isIgnoredDirectory(dirent.name)) subdirs.push(dirent.name);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (isJunkFile(dirent.name) || isThumbnailFile(dirent.name)) continue;
      files.push(dirent.name);
    }
    subdirs.sort(naturalCompare);

    const images = files.filter(isImageFile).sort(naturalCompare);
    const archives = files.filter(isArchiveFile).sort(naturalCompare);
    const videos = files.filter(isVideoFile).sort(naturalCompare);
    const hasComicInfo = files.some((name) => name.toLowerCase() === "comicinfo.xml");
    const hasEhviewer = files.some((name) => name.toLowerCase() === ".ehviewer");

    // 1) 游戏/程序目录：整目录跳过，避免把资源目录当作品。
    if (looksLikeGameDirectory(files) && images.length === 0) {
      options.onSkip?.({ path: current.rel || ".", reason: "疑似游戏/程序目录（含 exe/dll/pak）" });
      continue;
    }

    // 2.0) 合集（图集合集 / 视频合集）：作者目录或平台目录下按日期/套图分文件夹，
    //      合并成一个作品，每个子目录记为一个「分部（chapter）」，不再拆成几十个单文件夹作品。
    //      只对明确的图集层级或「子目录名几乎都是日期」启用；子目录含 ComicInfo/.ehviewer 视为单本漫画，不合并。
    if (
      current.depth > 0 &&
      subdirs.length >= 2 &&
      subdirs.length <= COLLECTION_MAX_SUBDIRS &&
      archives.length === 0 &&
      images.length <= COLLECTION_MAX_ROOT_IMAGES &&
      videos.length <= COLLECTION_MAX_ROOT_IMAGES
    ) {
      // 目录层级本身就是「整理」：子目录若是日期/序号/同一部作品的卷话，就合并成一个合集。
      const allGeneric = subdirs.every((name) => DATE_LIKE.test(name) || isVolumeLikeName(name));
      const sameWork = sharedChapterBase(subdirs) !== null;
      const organizedAsChapters =
        countGalleryLike(subdirs) === 0 && (allGeneric || sameWork || isSetCollectionPath(current.rel));
      // 含 E-H 画廊标记的目录（如 EhViewer 画廊库）保持“一画廊一作品”，不按章节合并。
      const setLike = !/ehviewer/i.test(current.rel) && organizedAsChapters;
      if (setLike) {
        const chapters = await collectCollectionChapters(current.abs, subdirs, images, videos);
        if (chapters) {
          const files = chapters.flatMap((chapter) => chapter.files);
          const videoCount = chapters.reduce((sum, chapter) => sum + chapter.videos.length, 0);
          works += 1;
          const inComicRoot = /^(本子|comic|漫画)(\/|$)/i.test(current.rel);
          yield {
            kind: files.length > 0 ? (inComicRoot ? "comic" : "image-set") : "video",
            sourceKind: "directory",
            relativePath: current.rel || ".",
            absolutePath: current.abs,
            title: deriveTitleFromName(current.rel.split("/").pop() ?? current.rel),
            gid: null,
            files,
            chapters,
            hasComicInfo: false,
          };
          options.onNote?.({
            path: current.rel || ".",
            reason: `按合集处理（${chapters.length} 个分部，${files.length} 页${
              videoCount > 0 ? `，${videoCount} 个视频` : ""
            }）`,
          });
          continue;
        }
      }
    }

    // 2) 视频作品：按番号归并，主片=同番号体积最大；无番号按策略处理（默认入库）。
    if (videos.length > 0 && images.length === 0) {
      const policy = options.unmatchedVideoPolicy ?? "as-work";
      const videoWorks = await planVideoWorks({
        current,
        videos,
        policy,
        onNote: options.onNote,
        onSkip: options.onSkip,
      });
      for (const work of videoWorks) {
        works += 1;
        yield work;
      }
      if (videoWorks.length > 0) continue;
      if (subdirs.length > 0) {
        // 目录里的视频一个都没入库时不要 `continue`：否则整个子树会被丢掉。
        options.onNote?.({
          path: current.rel || ".",
          reason: "目录内有未入库视频，已继续扫描其子目录",
        });
      }
    }

    // 3) 压缩包作品：每个包一个作品，不解压；页数在扫描阶段读中央目录得到。
    //    目录里同时有少量散图（<3 张，如封面/广告）时也按压缩包处理，避免整目录被漏掉。
    const fewImages = images.length < 3 && !hasComicInfo && !hasEhviewer;
    if (archives.length > 0 && (images.length === 0 || fewImages)) {
      for (const name of archives) {
        const stem = name.replace(/\.[^.]+$/, "");
        works += 1;
        yield {
          kind: "comic",
          sourceKind: "archive",
          relativePath: joinRelative(current.rel, name),
          absolutePath: join(current.abs, name),
          title: deriveTitleFromName(stem),
          gid: deriveGidFromName(stem),
          files: [],
          hasComicInfo,
        };
      }
      continue;
    }

    // 4) 图片/漫画作品：目录内直接含图片，且**没有子目录**。阈值：≥3 张或带 ComicInfo/.ehviewer。
    //    有子目录时继续下钻，避免几张广告图把同目录下的视频/漫画子目录整棵遮蔽（P0-2）。
    const isImageWork =
      subdirs.length === 0 && images.length >= 1 && (images.length >= 3 || hasComicInfo || hasEhviewer);
    if (!isImageWork && images.length >= 3 && subdirs.length > 0) {
      options.onNote?.({
        path: current.rel || ".",
        reason: `目录含 ${images.length} 张图片与 ${subdirs.length} 个子目录，按容器目录继续下钻`,
      });
    }
    // 4.5) 图片与视频同目录：图片照常收录后，视频单独成作品（不再被整目录吞掉）。
    if (videos.length > 0 && images.length > 0) {
      const videoWorks = await planVideoWorks({
        current,
        videos,
        policy: options.unmatchedVideoPolicy ?? "as-work",
        onNote: options.onNote,
        onSkip: options.onSkip,
      });
      for (const work of videoWorks) {
        works += 1;
        yield work;
      }
    }

    if (isImageWork) {
      works += 1;
      yield {
        kind: hasComicInfo || hasEhviewer ? "comic" : "image-set",
        sourceKind: "directory",
        relativePath: current.rel || ".",
        absolutePath: current.abs,
        title: deriveTitleFromName(current.rel.split("/").pop() ?? current.rel),
        gid: deriveGidFromName(current.rel.split("/").pop() ?? current.rel),
        files: images,
        hasComicInfo,
      };
      continue;
    }

    // 5) 递归子目录。
    if (current.depth >= maxDepth) {
      options.onSkip?.({
        path: current.rel || ".",
        reason: `深度超过 ${maxDepth}，未继续下钻`,
      });
      continue;
    }
    for (const name of subdirs) {
      queue.push({
        abs: join(current.abs, name),
        rel: joinRelative(current.rel, name),
        depth: current.depth + 1,
      });
    }
  }
}


async function readImageContainer(
  absDir: string,
  options: { probe: boolean },
): Promise<{
  images: string[];
  videos: string[];
  hasComicInfo: boolean;
  hasEhviewer: boolean;
  hasArchive: boolean;
  subdirs: string[];
} | null> {
  let dirents;
  try {
    dirents = await readdir(absDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const images: string[] = [];
  const videos: string[] = [];
  const subdirs: string[] = [];
  let hasComicInfo = false;
  let hasEhviewer = false;
  let hasArchive = false;
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      if (!isIgnoredDirectory(dirent.name)) subdirs.push(dirent.name);
      continue;
    }
    if (!dirent.isFile()) continue;
    const name = dirent.name;
    const lower = name.toLowerCase();
    if (lower === "comicinfo.xml") hasComicInfo = true;
    else if (lower === ".ehviewer") hasEhviewer = true;
    if (isJunkFile(name) || isThumbnailFile(name)) continue;
    if (isArchiveFile(name)) {
      hasArchive = true;
      continue;
    }
    if (isVideoFile(name)) {
      videos.push(name);
      continue;
    }
    if (isImageFile(name)) images.push(name);
  }
  if (options.probe) {
    return {
      images: images.slice(0, 3),
      videos: videos.slice(0, 1),
      hasComicInfo,
      hasEhviewer,
      hasArchive,
      subdirs,
    };
  }
  return { images, videos, hasComicInfo, hasEhviewer, hasArchive, subdirs: subdirs.sort(naturalCompare) };
}

const COLLECTION_MAX_SUBDIRS = 2000;
const COLLECTION_MAX_ROOT_IMAGES = 200;
const COLLECTION_MAX_FILES = 20_000;

const DATE_LIKE =
  /^(\d{4}[-_.]?\d{2}[-_.]?\d{2}.*|\d{4}[-_.]?\d{2}.*|(?:19|20)\d{2}年.*|(QQ|WeChat|Weixin|Weibo|Twitter|X|Pixiv|Instagram|INS|WB)[-_ ]?\d+.*|NO\.?\s*\d+.*|\d{1,4})$/i;
const PLATFORM_DIRS = /^(QQ|WeChat|Weixin|Weibo|微博|X|Twitter|Pixiv|Instagram|INS|WB)$/i;

function countDateLike(names: readonly string[]): number {
  return names.filter((name) => DATE_LIKE.test(name)).length;
}

/** 卷/话/分部式命名：第01话、vol.2、ch03、part1、01-02、上/下、前篇/后篇。 */
const VOLUME_LIKE =
  /^(?:第\s*\d{1,3}\s*[话話集卷部册]|(?:vol|volume|ch|chapter|part|ep|episode)[\s._-]*\d{1,3}|\d{1,3}(?:[._-]\d{1,3})?|(?:上|中|下)(?:卷|册|篇|话)?|前篇|后篇|序章|终章)/i;

function isVolumeLikeName(name: string): boolean {
  return VOLUME_LIKE.test(name.trim());
}

function countVolumeLike(names: readonly string[]): number {
  return names.filter(isVolumeLikeName).length;
}

/** 去掉卷/话/序号后缀后的标题基名；用于判断子目录是否是同一部作品的卷话。 */
function chapterBaseName(name: string): string {
  return name
    .replace(/(?:第\s*\d+\s*[话話集卷部册]|(?:vol|volume|ch|chapter|part|ep|episode)[\s._-]*\d{1,3}|\d{1,3})\s*$/i, "")
    .trim()
    .replace(/[\s._-]+$/, "");
}

/** 所有子目录去掉卷话后缀后是否共享同一基名（同一部作品的多卷/多话）。 */
function sharedChapterBase(names: readonly string[]): string | null {
  const bases = names.map(chapterBaseName).filter((base) => base !== "");
  if (bases.length !== names.length) return null;
  const unique = [...new Set(bases)];
  return unique.length === 1 && (unique[0]?.length ?? 0) >= 2 ? unique[0]! : null;
}

/** 画廊式命名（`1105992-标题`、`g1105992-标题`）：视为独立作品，不并入合集。 */
const GALLERY_LIKE = /^(?:g?\d{5,})[-_ ]/i;

function countGalleryLike(names: readonly string[]): number {
  return names.filter((name) => GALLERY_LIKE.test(name.trim())).length;
}

/** 合集的明确层级：`真人合集杂图/<作者>/<日期>`、`写真/<套图>`、`杂/QQ/...`。 */
function isSetCollectionPath(rel: string): boolean {
  const parts = rel.split("/");
  const top = parts[0] ?? "";
  // 真实库里的合集惯例：作者/平台目录下按日期或套图再分子目录。
  if (top === "真人合集杂图") return parts.length === 2 || parts.length === 3;
  if (top === "写真" || top === "图集" || top === "套图" || top === "cosplay" || top === "Cosplay") {
    return parts.length >= 2;
  }
  if (top === "杂") {
    if (parts.length === 2 && PLATFORM_DIRS.test(parts[1] ?? "")) return true;
    if (parts[1] === "作者合集") return parts.length === 3 || parts.length === 4;
    return false;
  }
  if (top === "av") return parts.length === 2 || parts.length === 3;
  // 兜底：漫画根（本子/comic/漫画）之外的二级目录默认按「合集父目录」尝试，
  // 是否真的合并交给 collectCollectionChapters 用内容校验（含 ComicInfo/压缩包则放弃）。
  if (parts.length >= 2 && !/^(本子|comic|漫画)$/i.test(top)) return true;
  return false;
}

/**
 * 收集合集分部：父目录下的子目录（或「包装层」里的孙目录）各算一个分部，图片与视频分别记录。
 * 含 ComicInfo/.ehviewer 的子目录视为单本漫画 → 放弃合并；含压缩包的目录不参与。
 */
async function collectCollectionChapters(
  absDir: string,
  subdirs: string[],
  rootImages: string[],
  rootVideos: string[],
): Promise<DiscoveredChapter[] | null> {
  const chapters: DiscoveredChapter[] = [];
  let totalFiles = 0;
  let aborted = false;

  const add = (title: string, files: string[], videos: string[]): void => {
    if (files.length === 0 && videos.length === 0) return;
    totalFiles += files.length + videos.length;
    if (totalFiles > COLLECTION_MAX_FILES) {
      aborted = true;
      return;
    }
    chapters.push({
      title,
      files: [...files].sort(naturalCompare),
      videos: [...videos].sort(naturalCompare),
    });
  };

  if (rootImages.length + rootVideos.length > 0) add("散图", rootImages, rootVideos);

  /**
   * 递归收集：子目录各算一个分部（图片和视频都记）。
   * 之前遇到「某层既有图片又有子目录」「某层含压缩包」就整棵放弃合并，
   * 导致图集被拆成一个个小作品；现在改为跳过该层、继续收集其它分部。
   */
  const visit = async (prefix: string, absPath: string, depth: number): Promise<void> => {
    if (aborted || depth > 4) return;
    const container = await readImageContainer(absPath, { probe: false });
    if (!container) return;
    // 单本漫画（ComicInfo/.ehviewer）或含压缩包：不并进合集，交给后面按作品处理。
    if (container.hasComicInfo || container.hasEhviewer || container.hasArchive) return;
    if (container.images.length > 0 || container.videos.length > 0) {
      const rel = (file: string): string => (prefix ? `${prefix}/${file}` : file);
      add(prefix || "散图", container.images.map(rel), container.videos.map(rel));
    }
    for (const child of container.subdirs.slice(0, 200)) {
      await visit(prefix ? `${prefix}/${child}` : child, join(absPath, child), depth + 1);
    }
  };

  for (const name of subdirs) {
    await visit(name, join(absDir, name), 0);
  }

  if (aborted) return null;
  if (chapters.length === 0) return null;
  // 两个及以上分部即视为合集；纯视频合集同样适用（不再受 3 文件下限限制）。
  if (chapters.length < 2) return null;
  if (totalFiles < 2) return null;
  return chapters;
}

/** 单目录探测：用于「把某个目录直接当作品添加」等场景。 */
export async function describeDirectory(absPath: string): Promise<{
  images: string[];
  archives: string[];
  videos: string[];
}> {
  const dirents = await readdir(absPath, { withFileTypes: true });
  const files = dirents.filter((d) => d.isFile()).map((d) => d.name).filter((n) => !isJunkFile(n));
  return {
    images: files.filter(isImageFile).sort(naturalCompare),
    archives: files.filter(isArchiveFile).sort(naturalCompare),
    videos: files.filter(isVideoFile).sort(naturalCompare),
  };
}

export function isSupportedMedia(name: string): boolean {
  return isImageFile(name) || isArchiveFile(name) || isVideoFile(name);
}

