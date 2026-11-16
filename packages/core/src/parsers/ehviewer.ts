/**
 * EhViewer 私有记录文件 `.ehviewer` 解析。
 *
 * 事实（EhViewer SpiderInfo.java）：VERSION2 起该文件是**文本行式**，不是 CBOR：
 *   VERSION2
 *   00000005 startPage     ← 阅读进度（%08x 前缀 + " startPage"）
 *   <gid>
 *   <token>
 *   <previewPages>
 *   <pages>
 *   <index> <pToken>       ← 每页 pToken，可多行
 * 旧版本是二进制数据；二进制直接返回 null（不猜）。
 *
 * 用途：刮削命中链路①——目录内 `.ehviewer` 能直接给出 gid + token，跳过站内搜索。
 */
export interface EhViewerInfo {
  version: number;
  gid: number | null;
  token: string | null;
  previewPages: number | null;
  pages: number | null;
  startPage: number | null;
  pTokens: Map<number, string>;
}

const HEX_TOKEN = /^[0-9a-f]{8,}$/i;

function toPositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 解析 `.ehviewer` 文本内容；无法识别返回 null。 */
export function parseEhViewerText(text: string): EhViewerInfo | null {
  if (!text || text.includes("\u0000")) return null; // 二进制旧格式
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const versionLine = /^VERSION(\d+)$/i.exec(lines[0] ?? "");
  if (!versionLine) return null;

  const info: EhViewerInfo = {
    version: Number(versionLine[1]),
    gid: null,
    token: null,
    previewPages: null,
    pages: null,
    startPage: null,
    pTokens: new Map(),
  };

  const headerNumbers: number[] = [];
  for (const line of lines.slice(1)) {
    const start = /^([0-9a-f]{1,8})\s+startPage$/i.exec(line);
    if (start) {
      info.startPage = Number.parseInt(start[1]!, 16);
      continue;
    }
    const pToken = /^(\d+)\s+([0-9a-f]+)$/i.exec(line);
    if (pToken) {
      info.pTokens.set(Number(pToken[1]), pToken[2]!);
      continue;
    }
    const number = toPositiveInt(line);
    if (number !== null) {
      headerNumbers.push(number);
      continue;
    }
    // token 行：8 位以上十六进制
    if (info.token === null && HEX_TOKEN.test(line)) {
      info.token = line.toLowerCase();
    }
  }

  if (headerNumbers.length > 0) info.gid = headerNumbers[0] ?? null;
  if (headerNumbers.length > 1) info.previewPages = headerNumbers[1] ?? null;
  if (headerNumbers.length > 2) info.pages = headerNumbers[2] ?? null;
  return info;
}
