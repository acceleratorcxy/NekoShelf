import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { open as openZip, type Entry, type ZipFile } from "yauzl";
import { naturalCompare } from "../parsers/natural.js";
import { isJunkFile, isThumbnailFile } from "./rules.js";

export interface ArchiveEntry {
  /** 包内路径（`/` 分隔）。 */
  name: string;
  /** 未压缩大小，未知为 undefined。 */
  size?: number;
  /** 是否为目录条目。 */
  directory: boolean;
}

export interface ArchiveListing {
  /** 可阅读页面（按自然序排序），非图片条目已被过滤。 */
  pages: ArchiveEntry[];
  /** 包内全部条目数（含非图片），用于页数校验。 */
  totalEntries: number;
  /** 无法读取时的错误，页面列表为空。 */
  error?: string;
}

export type ArchiveKind = "zip" | "7z" | "rar" | "unknown";

const IMAGE_ENTRY = /\.(jpe?g|png|webp|avif|gif|bmp|jxl|tiff?)$/i;

/* ------------------------------ zip 系（yauzl） ------------------------------ */

/**
 * 读取 zip/cbz（含伪装成 cbr 的 zip）中央目录，不解压。
 * 大包只做流式条目枚举，绝不读文件内容。
 */
export function listZipEntries(
  archivePath: string,
  options: { maxEntries?: number } = {},
): Promise<ArchiveListing> {
  const maxEntries = options.maxEntries ?? 200_000;
  return new Promise((resolve) => {
    const entries: ArchiveEntry[] = [];
    let settled = false;
    const finish = (result: ArchiveListing): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    openZip(archivePath, { lazyEntries: true, autoClose: true }, (error, zipfile) => {
      if (error || !zipfile) {
        finish({ pages: [], totalEntries: 0, error: error?.message ?? "无法打开压缩包" });
        return;
      }
      const file: ZipFile = zipfile;
      let total = 0;
      file.on("error", (zipError: Error) => {
        finish({ pages: [], totalEntries: total, error: zipError.message });
      });
      file.on("entry", (entry: Entry) => {
        total += 1;
        if (total > maxEntries) {
          file.close();
          finish({ pages: [], totalEntries: total, error: "条目数超过上限" });
          return;
        }
        const directory = entry.fileName.endsWith("/");
        if (
          !directory &&
          IMAGE_ENTRY.test(entry.fileName) &&
          !isJunkFile(entry.fileName) &&
          !isThumbnailFile(entry.fileName)
        ) {
          entries.push({ name: entry.fileName, size: entry.uncompressedSize, directory });
        }
        file.readEntry();
      });
      file.on("end", () => {
        entries.sort((a, b) => naturalCompare(a.name, b.name));
        finish({ pages: entries, totalEntries: total });
      });
      file.readEntry();
    });
  });
}

/** 读取 zip 内某个条目的原始字节（只解该条目，不落盘）。 */
export function readZipEntry(archivePath: string, entryName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    openZip(archivePath, { lazyEntries: true, autoClose: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(new Error(`无法打开压缩包：${error?.message ?? "unknown"}`));
        return;
      }
      let found = false;
      const fail = (reason: string): void => {
        zipfile.close();
        reject(new Error(reason));
      };
      zipfile.on("error", () => fail("压缩包损坏"));
      zipfile.on("entry", (entry: Entry) => {
        if (entry.fileName !== entryName) {
          zipfile.readEntry();
          return;
        }
        found = true;
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail("无法读取压缩包条目");
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => resolve(Buffer.concat(chunks)));
          stream.on("error", () => fail("读取压缩包条目失败"));
        });
      });
      zipfile.on("end", () => {
        if (!found) reject(new Error("压缩包内不存在该条目"));
      });
      zipfile.readEntry();
    });
  });
}

/* --------------------------- 7z / rar 系（外部工具） --------------------------- */

/**
 * 外部压缩包工具链。Windows 开发机多为便携版 `7z.exe`（自带 RAR 解码）；Linux 镜像内的
 * Debian `7zip`（7zz）不含 RAR 解码器，`p7zip-full`（7z）只能解 RAR3（RAR5 报 Unsupported Method），
 * 因此 RAR 最终兜底走 `bsdtar`（libarchive，支持 RAR5）。可用环境变量 `NEKO_7Z` 覆盖
 * 7z 家族的命令（绝对路径或命令名），`NEKO_BSD_TAR` 覆盖 bsdtar。
 */
function toolChain(kind?: ArchiveKind): string[] {
  const override = process.env.NEKO_7Z?.trim();
  if (override) return [override];
  if (process.platform !== "win32") {
    return kind === "rar" ? ["7z", "7zz"] : ["7zz", "7z"];
  }
  const candidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "7-Zip", "7z.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "7-Zip", "7z.exe"),
    join(homedir(), "bin", "7zip", "7z.exe"),
    join(homedir(), "bin", "7z", "7z.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return [candidate];
  }
  return ["7z"];
}

function bsdTar(): string {
  return process.env.NEKO_BSD_TAR?.trim() || "bsdtar";
}

/** 当前首选压缩包工具（`kind` 为 `rar` 时在 Linux 上会选 p7zip 的 `7z`）。 */
export function resolveArchiveTool(kind?: ArchiveKind): string {
  return toolChain(kind)[0]!;
}

interface ToolResult {
  stdout: Buffer;
  stderr: string;
}

function spawnArchiveTool(command: string, args: string[], timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("压缩包工具执行超时"));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const missing = error.code === "ENOENT" ? `工具未安装（${command}）` : error.message;
      reject(Object.assign(new Error(missing), { toolMissing: error.code === "ENOENT" }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim().split(/\r?\n/).slice(-1)[0] || `压缩包工具退出码 ${code}`));
        return;
      }
      resolve({ stdout: Buffer.concat(chunks), stderr });
    });
  });
}

async function runArchiveTool(args: string[], kind?: ArchiveKind): Promise<ToolResult> {
  const chain = toolChain(kind);
  let lastError: unknown;
  for (const command of chain) {
    try {
      return await spawnArchiveTool(command, args, 180_000);
    } catch (error) {
      lastError = error;
      const missing = (error as { toolMissing?: boolean }).toolMissing === true;
      // 只有「工具缺失」或 RAR 解不出（Linux 7zz 无 RAR 解码器）时才继续换下一个工具。
      if (!missing && kind !== "rar") throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("压缩包工具不可用");
}

/** 解析 `7zz l -slt` 的键值块输出。 */
function parseSltOutput(output: string, archivePath: string): ArchiveEntry[] {
  const archiveName = archivePath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const blocks = output.split(/\r?\n\r?\n/);
  const entries: ArchiveEntry[] = [];
  for (const block of blocks) {
    if (!block.includes("Path = ")) continue;
    // 归档自身信息块包含 Type = ，跳过
    if (/\bType = /.test(block)) continue;
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const eq = line.indexOf(" = ");
      if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 3).trim());
    }
    const name = fields.get("Path");
    if (!name || name.toLowerCase() === archiveName) continue;
    const attributes = fields.get("Attributes") ?? "";
    const hasSize = fields.has("Size");
    const directory = name.endsWith("/") || (!hasSize && /^D/i.test(attributes));
    if (
      !directory &&
      IMAGE_ENTRY.test(name) &&
      !isJunkFile(name) &&
      !isThumbnailFile(name)
    ) {
      const size = fields.get("Size");
      entries.push({ name, size: size ? Number(size) : undefined, directory });
    }
  }
  entries.sort((a, b) => naturalCompare(a.name, b.name));
  return entries;
}

/** 用 bsdtar（libarchive）列出 RAR 条目：RAR5 的解压兜底，列表不含可靠大小。 */
async function listRarWithBsdTar(archivePath: string): Promise<ArchiveEntry[]> {
  const { stdout } = await spawnArchiveTool(bsdTar(), ["-tf", archivePath], 180_000);
  const entries: ArchiveEntry[] = [];
  for (const raw of stdout.toString("utf8").split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const directory = trimmed.endsWith("/");
    const name = directory ? trimmed.replace(/\/+$/, "") : trimmed;
    if (!directory && IMAGE_ENTRY.test(name) && !isJunkFile(name) && !isThumbnailFile(name)) {
      entries.push({ name, directory });
    }
  }
  entries.sort((a, b) => naturalCompare(a.name, b.name));
  return entries;
}

/** 读取 7z / rar 的条目列表（需要 7zz/7z；只列目录信息，不解压）。 */
export async function list7zEntries(
  archivePath: string,
  options: { maxEntries?: number; kind?: ArchiveKind } = {},
): Promise<ArchiveListing> {
  const maxEntries = options.maxEntries ?? 200_000;
  try {
    const { stdout } = await runArchiveTool(["l", "-slt", "-y", archivePath], options.kind);
    const entries = parseSltOutput(stdout.toString("utf8"), archivePath);
    if (entries.length > maxEntries) {
      return { pages: entries.slice(0, maxEntries), totalEntries: entries.length, error: "条目数超过上限" };
    }
    return { pages: entries, totalEntries: entries.length };
  } catch (error) {
    // RAR 列表失败（多半是解压器不支持 RAR5）→ libarchive 兜底
    if (options.kind === "rar" && process.platform !== "win32") {
      try {
        const entries = await listRarWithBsdTar(archivePath);
        if (entries.length > 0) {
          return {
            pages: entries.slice(0, maxEntries),
            totalEntries: entries.length,
            ...(entries.length > maxEntries ? { error: "条目数超过上限" } : {}),
          };
        }
      } catch {
        // 落到下面的统一错误
      }
    }
    return {
      pages: [],
      totalEntries: 0,
      error: error instanceof Error ? error.message : "无法读取压缩包",
    };
  }
}

/** 读取 7z / rar 内某个条目的原始字节（只解该条目到内存）。 */
export async function read7zEntry(
  archivePath: string,
  entryName: string,
  kind?: ArchiveKind,
): Promise<Buffer> {
  try {
    const { stdout } = await runArchiveTool(["e", "-so", "-y", archivePath, entryName], kind);
    if (stdout.byteLength === 0) throw new Error("压缩包内不存在该条目");
    return stdout;
  } catch (error) {
    // p7zip 16.02 只认 RAR3（RAR5 报 Unsupported Method）→ libarchive 兜底
    if (kind === "rar" && process.platform !== "win32") {
      const { stdout } = await spawnArchiveTool(bsdTar(), ["-xOf", archivePath, entryName], 180_000);
      if (stdout.byteLength === 0) throw new Error("压缩包内不存在该条目");
      return stdout;
    }
    throw error;
  }
}

/* -------------------------------- 统一入口 -------------------------------- */

/** 读文件头判断真实格式，不信任扩展名（cbr 经常是 zip）。 */
export async function detectArchiveKind(archivePath: string): Promise<ArchiveKind> {
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await openFile(archivePath, "r");
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, 8, 0);
    if (bytesRead < 4) return "unknown";
    if (header[0] === 0x50 && header[1] === 0x4b) return "zip"; // PK..
    if (header.subarray(0, 4).toString("latin1") === "Rar!") return "rar";
    if (header.subarray(0, 6).toString("hex") === "377abcaf271c") return "7z";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    await handle?.close();
  }
}

/** 列出任意受支持压缩包的页（zip 走中央目录，7z/rar 走 7zz）。 */
export async function listArchiveEntries(
  archivePath: string,
  options: { maxEntries?: number } = {},
): Promise<ArchiveListing> {
  const kind = await detectArchiveKind(archivePath);
  if (kind === "zip") return listZipEntries(archivePath, options);
  if (kind === "7z" || kind === "rar") return list7zEntries(archivePath, { ...options, kind });
  return { pages: [], totalEntries: 0, error: "不是可识别的压缩包格式" };
}

/** 读取任意受支持压缩包内某个条目的字节。 */
export async function readArchiveContent(archivePath: string, entryName: string): Promise<Buffer> {
  const kind = await detectArchiveKind(archivePath);
  if (kind === "zip") return readZipEntry(archivePath, entryName);
  if (kind === "7z" || kind === "rar") return read7zEntry(archivePath, entryName, kind);
  throw new Error("不是可识别的压缩包格式");
}

/** 兼容旧名：读取压缩包条目。 */
export const readArchiveEntry = readArchiveContent;

/** 是否为可读压缩包（格式正确与否在读取时判定）。 */
export function canListArchive(name: string): boolean {
  return /\.(zip|cbz|cbr|7z|cb7|rar)$/i.test(name);
}
