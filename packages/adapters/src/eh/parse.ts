/**
 * E-H（里站 exhentai）HTML/JSON 解析。
 * 纯函数：不碰网络、不读写磁盘，便于用脱敏夹具做单测。
 */

export interface EhTag {
  namespace: string;
  name: string;
}

export interface EhMetadata {
  gid: number | null;
  token: string | null;
  title: string | null;
  titleJpn: string | null;
  category: string | null;
  posted: string | null;
  uploader: string | null;
  fileCount: number | null;
  tags: EhTag[];
  url: string | null;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  "#x27": "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x")) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
    return ENTITIES[key] ?? raw;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** 从详情页 `td.gdt1/td.gdt2` 结构里取字段（E-H 页面结构多年未变）。 */
function fieldValue(html: string, label: string): string | null {
  const pattern = new RegExp(
    `<td[^>]*class="gdt1"[^>]*>\\s*${label}:?\\s*</td>\\s*<td[^>]*class="gdt2"[^>]*>([\\s\\S]*?)</td>`,
    "i",
  );
  const match = html.match(pattern);
  if (!match?.[1]) return null;
  const value = stripTags(match[1]);
  return value.length > 0 ? value : null;
}

/**
 * 解析画廊详情页。
 * 传入 gid/token 时以其为准（页面 URL 归一化），否则从 canonical 链接提取。
 */
export function parseGalleryHtml(html: string, gid?: number, token?: string): EhMetadata | null {
  if (!html || html.length === 0) return null;

  const title = stripTags(html.match(/<h1[^>]*id="gn"[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "") || null;
  const titleJpn =
    stripTags(html.match(/<h1[^>]*id="gj"[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "") || null;

  const canonical = html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i)?.[1] ?? null;
  const urlMatch = canonical?.match(/\/g\/(\d+)\/([0-9a-f]+)/i) ?? null;

  const fileCountRaw = fieldValue(html, "Length");
  const fileCountMatch = fileCountRaw?.match(/(\d+)\s*pages?/i) ?? null;

  const category = fieldValue(html, "Category");
  const posted = fieldValue(html, "Posted");
  const uploader = fieldValue(html, "Uploader");

  // 标签区：每个命名空间一个 `<div class="gt">namespace</div>`，后跟若干 <a href=".../tag/...">
  const tags: EhTag[] = [];
  const tagArea = html.match(/<div[^>]*id="taglist"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1] ?? html;
  const sections = tagArea.split(/<div[^>]*class="gt"[^>]*>/i).slice(1);
  for (const section of sections) {
    const namespace = stripTags(section.split("</div>")[0] ?? "").replace(/:$/, "").trim();
    if (!namespace) continue;
    // 标签链接形如 /tag/language/chinese、/artist/xxx；名字取链接文本，命名空间取自上方 gt 块
    const linkPattern = /<a[^>]*href="[^"]*\/(?:tag|artist|group|circle|uploader|parody|character)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = linkPattern.exec(section)) !== null) {
      const name = stripTags(match[1] ?? "");
      if (name.length > 0 && !tags.some((tag) => tag.namespace === namespace && tag.name === name)) {
        tags.push({ namespace: namespace.toLowerCase(), name });
      }
    }
  }

  return {
    gid: gid ?? (urlMatch ? Number(urlMatch[1]) : null),
    token: token ?? (urlMatch ? urlMatch[2]?.toLowerCase() : null) ?? null,
    title,
    titleJpn,
    category,
    posted,
    uploader,
    fileCount: fileCountMatch ? Number(fileCountMatch[1]) : null,
    tags,
    url: canonical,
  };
}

/** 解析 `api.php?method=gdata` 的返回；gid 顺序与请求一致。 */
export function parseGdataResponse(
  payload: unknown,
  requestedGids: readonly number[] = [],
): EhMetadata[] {
  const list = (payload as { gmetadata?: unknown })?.gmetadata;
  if (!Array.isArray(list)) return [];
  return list.map((raw, index) => {
    const item = raw as Record<string, unknown>;
    const gid = typeof item.gid === "number" ? item.gid : (requestedGids[index] ?? null);
    const tagStrings = Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string") : [];
    const tags: EhTag[] = [];
    for (const tag of tagStrings) {
      const [namespace, ...rest] = tag.split(":");
      const name = rest.join(":").trim();
      if (!namespace || !name) continue;
      tags.push({ namespace: namespace.trim().toLowerCase(), name });
    }
    const token = typeof item.token === "string" ? item.token.toLowerCase() : null;
    return {
      gid,
      token,
      title: typeof item.title === "string" ? item.title : null,
      titleJpn: typeof item.title_jpn === "string" ? item.title_jpn : null,
      category: typeof item.category === "string" ? item.category : null,
      posted: typeof item.posted === "string" ? item.posted : null,
      uploader: typeof item.uploader === "string" ? item.uploader : null,
      fileCount:
        typeof item.filecount === "number"
          ? item.filecount
          : typeof item.filecount === "string" && /^\d+$/.test(item.filecount)
            ? Number(item.filecount)
            : null,
      tags,
      url: gid !== null && token ? `https://exhentai.org/g/${gid}/${token}/` : null,
    };
  });
}

/** 从搜索页里找 `gid` 对应的 `/g/{gid}/{token}/` 链接。 */
export function parseSearchForToken(html: string, gid: number): string | null {
  const pattern = /\/g\/(\d+)\/([0-9a-f]{10})\//gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (Number(match[1]) === gid) return match[2]!.toLowerCase();
  }
  return null;
}

/** 判定「未登录 / 登录失效」页面（里站会渲染登录提示而非目标内容）。 */
export function looksLikeLoginPage(html: string, finalUrl?: string): boolean {
  if (finalUrl && /\/(login|signin|bounce)/i.test(finalUrl)) return true;
  return /You must be a member|sign in|登录|ipb_login|Sign in to continue/i.test(html);
}

/** 判定 Cloudflare 挑战页。 */
export function looksLikeCfChallenge(html: string, mitigatedHeader?: string | null): boolean {
  if (mitigatedHeader && /challenge/i.test(mitigatedHeader)) return true;
  return /Just a moment|cf-challenge|Enable JavaScript and cookies to continue/i.test(html);
}
