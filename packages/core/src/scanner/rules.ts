/** 扫描期判定规则：系统目录、下载中间态、可识别媒体扩展名。 */

/** 目录名黑名单（大小写不敏感）：不进入、不索引。 */
const IGNORED_DIRS = new Set([
  "@eadir",
  "#recycle",
  "#snapshot",
  "#recycle_bin",
  "lost+found",
  "system volume information",
  "$recycle.bin",
  ".git",
  ".svn",
  "node_modules",
]);

/** 目录名前缀黑名单：隐藏目录与 Synology 回收站。 */
export function isIgnoredDirectory(name: string): boolean {
  if (name.startsWith(".")) return true;
  return IGNORED_DIRS.has(name.toLowerCase());
}

/** 下载中/临时文件。 */
const DOWNLOAD_SUFFIXES = [
  ".pptd",
  ".part",
  ".crdownload",
  ".downloading",
  ".aria2",
  ".!qb",
  ".tmp",
  ".tmp!",
  ".partial",
];

/** 同名伴生配置文件（.cfg / .pptd.cfg）与下载临时文件。 */
export function isDownloadArtifact(name: string): boolean {
  const lower = name.toLowerCase();
  if (/\.(pptd|part|downloading|crdownload|aria2|!qb|tmp)$/i.test(lower)) return true;
  if (/(\.(pptd|part|downloading))?\.cfg$/i.test(lower)) return true;
  return DOWNLOAD_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** 无意义系统文件，静默跳过（不算「下载中」）。 */
export function isJunkFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === ".ds_store" ||
    lower === "thumbs.db" ||
    lower === "desktop.ini" ||
    lower.startsWith("._") ||
    isDownloadArtifact(name)
  );
}

/**
 * 预览图而非书页：EhViewer 等下载器会在作品目录里放 `thumb.webp`。
 * 它不能计入页数，否则阅读器会多出一页缩略图（实测样本 1885 个目录每个都带 thumb.webp）。
 */
export function isThumbnailFile(name: string): boolean {
  return /^thumb\.(webp|jpe?g|png)$/i.test(name);
}

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".gif",
  ".bmp",
  ".jxl",
  ".tif",
  ".tiff",
]);

const ARCHIVE_EXTENSIONS = new Set([".zip", ".cbz", ".rar", ".cbr", ".7z", ".cb7"]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".wmv",
  ".mov",
  ".webm",
  ".m4v",
  ".ts",
  ".flv",
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

export function isArchiveFile(name: string): boolean {
  return ARCHIVE_EXTENSIONS.has(extensionOf(name));
}

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(name));
}

/** zip 系（可随机读中央目录，页数无需解压）。 */
export function isZipBased(name: string): boolean {
  const ext = extensionOf(name);
  return ext === ".zip" || ext === ".cbz" || ext === ".cbr";
}

/**
 * 猜测压缩包「形似视频/图片」的伪装包（如 `xxx.cbz` 实为 mp4）。
 * 仅凭文件名无法判断，需读文件头；当前只做已知危险后缀的标记，真正校验在读取时。
 */
export function looksLikeCoverImage(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "cover.jpg" ||
    lower === "cover.png" ||
    lower === "cover.webp" ||
    lower === "folder.jpg" ||
    lower === "folder.png"
  );
}
