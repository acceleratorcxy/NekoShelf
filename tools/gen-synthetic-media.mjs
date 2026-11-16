// 生成公开仓库用的「合成示例媒体」（不含任何真实作品内容），仅用于截图。
// 用法：node tools/gen-synthetic-media.mjs <输出目录>
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const sharp = require("sharp");

const out = process.argv[2];
if (!out) throw new Error("usage: node tools/gen-synthetic-media.mjs <dir>");

const PALETTE = ["#2f6f4e", "#2b4d7a", "#7a2b52", "#6b4a1f", "#3a3a6f", "#1f6b6b"];

async function page(bg, title, pageNo, total) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1024">
    <rect width="720" height="1024" fill="${bg}"/>
    <rect x="40" y="40" width="640" height="944" fill="none" stroke="#ffffff" stroke-opacity="0.28" stroke-width="3" rx="18"/>
    <text x="360" y="300" font-family="Noto Sans CJK SC, sans-serif" font-size="54" fill="#ffffff" fill-opacity="0.92" text-anchor="middle">${title}</text>
    <text x="360" y="520" font-family="Noto Sans CJK SC, sans-serif" font-size="240" fill="#ffffff" fill-opacity="0.22" text-anchor="middle">${pageNo}</text>
    <text x="360" y="920" font-family="Noto Sans CJK SC, sans-serif" font-size="30" fill="#ffffff" fill-opacity="0.6" text-anchor="middle">示例页面 ${pageNo} / ${total}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 82 }).toBuffer();
}

async function makeWork(dir, { title, pages, series, writer, artist, tags }) {
  const workDir = join(out, dir);
  await mkdir(workDir, { recursive: true });
  const color = PALETTE[Math.abs(hash(title)) % PALETTE.length];
  for (let i = 1; i <= pages; i++) {
    const no = String(i).padStart(3, "0");
    await writeFile(join(workDir, `${no}.webp`), await page(color, title, i, pages));
  }
  if (series || writer || artist) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Title>${title}</Title>
  ${series ? `<Series>${series}</Series>` : ""}
  ${writer ? `<Writer>${writer}</Writer>` : ""}
  ${artist ? `<Penciller>${artist}</Penciller>` : ""}
  ${tags ? `<Tags>${tags}</Tags>` : ""}
  <PageCount>${pages}</PageCount>
</ComicInfo>`;
    await writeFile(join(workDir, "ComicInfo.xml"), xml, "utf8");
  }
}

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) | 0;
  return h;
}

await mkdir(out, { recursive: true });
await makeWork(join("示例库", "漫画", "示例作品甲"), { title: "示例作品甲", pages: 6, series: "示例系列", writer: "示例会社", artist: "示例画师", tags: "女装,巨乳,Full Color" });
await makeWork(join("示例库", "漫画", "示例作品乙"), { title: "示例作品乙", pages: 5, series: "示例系列", writer: "示例会社", artist: "示例画师", tags: "女装,巨乳" });
await makeWork(join("示例库", "图集", "示例画集 [12P-3MB]"), { title: "示例画集", pages: 12 });
await makeWork(join("示例库", "图集", "示例写真集"), { title: "示例写真集", pages: 8 });
await mkdir(join(out, "示例库", "视频", "示例剧集"), { recursive: true });
console.log("synthetic media written to", out);
