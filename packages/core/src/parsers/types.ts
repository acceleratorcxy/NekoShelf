/**
 * 解析规则的类型定义。
 * 所有解析器必须是纯函数：输入文件/目录名，输出结构化结果，不触碰磁盘。
 */

/** 内容种类。 */
export type ContentKind = "comic" | "archive" | "image-set" | "video" | "unknown";

/** EhViewer 画廊目录名 `{gid}-{title}`。 */
export interface GidDirectory {
  gid: number;
  title: string;
}

/** 文件/目录名里声明式给出的页数、视频数、体积。 */
export interface PageDeclaration {
  /** 声明的页数（`[57P-795MB]` → 57）。 */
  pages: number | null;
  /** `[463P+67P]` 这类「两段页数」的第二段，合计 = pages + pagesExtra。 */
  pagesExtra: number | null;
  /** 合计页数（pages + pagesExtra，若只有一段则等于 pages）。 */
  totalPages: number | null;
  /** 声明的视频数（`[108P+7V]` → 7）。 */
  videos: number | null;
  /** 声明的体积（字节）。 */
  bytes: number | null;
  /** 命中的原始片段，便于日志与「用户可见的命中依据」。 */
  raw: string;
}

/** AV 文件名解析结果。 */
export interface AvFilename {
  /** 标准番号，如 `ABC-123`。 */
  code: string;
  /** 广告域名前缀（如 `ads.com@`），已从名称剥离。 */
  sitePrefix: string | null;
  /** 版本后缀标记：`CH`/`CHC`/`UC`/`C`/`SD`/`HD`/`FHD`/`4K`/`VR`。 */
  versionTags: string[];
  /** 去掉广告前缀后的名称（便于标题展示）。 */
  cleanedName: string;
}

/** 从文件名/目录名里抽取的标签类信息。 */
export interface NameTags {
  /** 活动标记，如 `C104`、`例大祭12`、`COMIC1☆3`、`COSPATIO10`。 */
  events: string[];
  /** 发布/汉化组，如 `[にのこや (にの子)]`、`[战樱翻译]`。 */
  groups: string[];
  /** 语言标记：`中国翻訳`/`漢化`/`Chinese`/`中国翻译`。 */
  languages: string[];
  /** 版本/质量标记：`無修正`、`uncensored`、`AI Generated`、`DL版`、`Decensored`。 */
  qualities: string[];
  /** 尾部 gid 候选（如 `...[4163459].zip`）。 */
  trailingGid: number | null;
}

/** 媒体文件/目录解析的聚合结果（扫描器入库的主要输入）。 */
export interface MediaNameParse {
  /** 原始名称（不含路径）。 */
  raw: string;
  /** 内容种类。 */
  kind: ContentKind;
  /** 目录名形式的画廊 gid（仅目录）。 */
  gidDirectory: GidDirectory | null;
  /** 名称中声明的页数/体积。 */
  pageDeclaration: PageDeclaration | null;
  /** AV 文件名解析（仅视频）。 */
  av: AvFilename | null;
  /** 标签类信息。 */
  tags: NameTags;
}
