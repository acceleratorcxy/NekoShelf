import { describe, expect, it } from "vitest";
import {
  findTrailingGid,
  naturalCompare,
  parseAvFilename,
  parseGidDirectory,
  parseMediaFilename,
  parseNameTags,
  parsePageDeclaration,
  isDownloadCompanion,
  isDownloadTemp,
  sortNatural,
} from "../src/index.js";

describe("parseGidDirectory（EhViewer 目录 {gid}-{title}）", () => {
  it("解析真实形态的目录名", () => {
    expect(parseGidDirectory("1890123-[にのこや (にの子)] にのこやC104おまけ本")).toEqual({
      gid: 1890123,
      title: "[にのこや (にの子)] にのこやC104おまけ本",
    });
  });

  it("5 位与 8 位 gid 都接受", () => {
    expect(parseGidDirectory("12345-短 gid")?.gid).toBe(12345);
    expect(parseGidDirectory("12345678-长 gid")?.gid).toBe(12345678);
  });

  it("不是 {gid}- 开头的一律不认", () => {
    expect(parseGidDirectory("ads.com@ABC-123")).toBeNull();
    expect(parseGidDirectory("1234-太短")).toBeNull();
    expect(parseGidDirectory("(C104) [にのこや] おまけ本")).toBeNull();
    expect(parseGidDirectory("1890123-")).toBeNull();
  });
});

describe("findTrailingGid（尾部 [gid] 候选）", () => {
  it("从真实压缩包名取末尾 gid", () => {
    expect(
      findTrailingGid(
        "[MacArooN] 洞玄尘心道归真 全七话+无字封面 [463P+67P] [uncensored] [AI Generated][4163459]",
      ),
    ).toBe(4163459);
  });

  it("没有尾部数字时返回 null", () => {
    expect(findTrailingGid("COMIC BAVEL 2025年8月号 [中国翻訳] [無修正] [DL版]")).toBeNull();
  });
});

describe("parsePageDeclaration", () => {
  it("[57P-795MB] → 57 页 + 体积", () => {
    const parsed = parsePageDeclaration("写真 [57P-795MB]");
    expect(parsed?.pages).toBe(57);
    expect(parsed?.videos).toBeNull();
    expect(parsed?.bytes).toBe(57_795 * 0 + 795 * 1024 * 1024);
  });

  it("[463P+67P] → 两段页数合计 530", () => {
    const parsed = parsePageDeclaration("[MacArooN] 道归真 [463P+67P] [uncensored] [4163459]");
    expect(parsed?.pages).toBe(463);
    expect(parsed?.pagesExtra).toBe(67);
    expect(parsed?.totalPages).toBe(530);
  });

  it("[108P+7V] → 页数 + 视频数", () => {
    const parsed = parsePageDeclaration("某作者 - 合集 [108P+7V]");
    expect(parsed?.pages).toBe(108);
    expect(parsed?.videos).toBe(7);
  });

  it("[108P+7V-1.23GB] → 页数 + 视频数 + 体积", () => {
    const parsed = parsePageDeclaration("套图 [108P+7V-1.23GB]");
    expect(parsed?.pages).toBe(108);
    expect(parsed?.videos).toBe(7);
    expect(parsed?.bytes).toBeCloseTo(1.23 * 1024 ** 3, 0);
  });

  it("没有声明时返回 null", () => {
    expect(parsePageDeclaration("COMIC BAVEL 2025年8月号 [DL版]")).toBeNull();
  });
});

describe("parseAvFilename", () => {
  it("剥离广告域名前缀", () => {
    const parsed = parseAvFilename("ads.com@ABC-123.mp4");
    expect(parsed?.code).toBe("ABC-123");
    expect(parsed?.sitePrefix).toBe("ads.com@");
    expect(parsed?.versionTags).toEqual([]);
  });

  it("识别版本后缀，且不把 CHC 拆成 CH", () => {
    expect(parseAvFilename("XYZ-456_CH_SD.mp4")?.versionTags).toEqual(["CH", "SD"]);
    expect(parseAvFilename("SSIS-123_CHC.mp4")?.versionTags).toEqual(["CHC"]);
  });

  it("无番号的文件返回 null", () => {
    expect(parseAvFilename("2048地址发布器.apk")).toBeNull();
    expect(parseAvFilename("xuu9x短视频.mp4")).toBeNull();
    expect(parseAvFilename("【某合集】某合集.mp4")).toBeNull();
  });

  it("小写番号也能识别并归一为大写", () => {
    expect(parseAvFilename("abc-123.mp4")?.code).toBe("ABC-123");
  });
});

describe("parseNameTags（活动/汉化组/语言/质量）", () => {
  it("C104 + 汉化组 + 语言 + 尾部 gid", () => {
    const tags = parseNameTags(
      "[MacArooN] 洞玄尘心道归真 [463P+67P] [uncensored] [AI Generated][4163459]",
    );
    expect(tags.groups).toContain("MacArooN");
    expect(tags.qualities).toEqual(expect.arrayContaining(["uncensored", "AI Generated"]));
    expect(tags.trailingGid).toBe(4163459);
  });

  it("活动标记与翻译标记分类正确", () => {
    const tags = parseNameTags(
      "(C104) [にのこや (にの子)] にのこやC104おまけ本 [中国翻訳] [战樱翻译] [無修正]",
    );
    expect(tags.events).toContain("C104");
    expect(tags.languages).toContain("zh");
    expect(tags.qualities).toContain("uncensored");
    expect(tags.groups).toContain("にのこや (にの子)");
    expect(tags.groups).toContain("战樱翻译");
    expect(tags.groups).not.toContain("中国翻訳");
    expect(tags.groups).not.toContain("無修正");
  });

  it("例大祭 / COMIC1 / COSPATIO", () => {
    expect(parseNameTags("例大祭12 [社团] 本.zip").events).toContain("例大祭12");
    expect(parseNameTags("COMIC1☆3 [社团] 本.zip").events.length).toBeGreaterThan(0);
    expect(parseNameTags("COSPATIO24 某本.zip").events.length).toBeGreaterThan(0);
  });
});

describe("下载中文件保护", () => {
  it("网盘下载中间态与伴生 cfg 都要跳过", () => {
    expect(isDownloadTemp("某本.zip.pptd")).toBe(true);
    expect(isDownloadTemp("某本.zip.part")).toBe(true);
    expect(isDownloadTemp("某本.zip.aria2")).toBe(true);
    expect(isDownloadCompanion("某本.zip.pptd.cfg")).toBe(true);
    expect(isDownloadCompanion("某本.zip.cfg")).toBe(true);
    expect(isDownloadTemp("某本.zip")).toBe(false);
    expect(isDownloadCompanion("某本.zip")).toBe(false);
  });
});

describe("parseMediaFilename（聚合）", () => {
  it("视频条目带番号", () => {
    const parsed = parseMediaFilename("ads.com@ABC-123.mp4", { isDirectory: false });
    expect(parsed.kind).toBe("video");
    expect(parsed.av?.code).toBe("ABC-123");
  });

  it("目录条目按 {gid}- 识别为漫画", () => {
    const parsed = parseMediaFilename("1890123-[社团] 标题 (C104)", { isDirectory: true });
    expect(parsed.kind).toBe("comic");
    expect(parsed.gidDirectory?.gid).toBe(1890123);
    expect(parsed.tags.events).toContain("C104");
  });

  it("套图目录声明解析", () => {
    const parsed = parseMediaFilename("某作者 - NO.01 牛仔裤 [23P-164MB]", {
      isDirectory: true,
    });
    expect(parsed.pageDeclaration?.pages).toBe(23);
    expect(parsed.pageDeclaration?.bytes).toBe(164 * 1024 * 1024);
  });
});

describe("naturalCompare", () => {
  it("数字段按数值比较，530 页不错乱", () => {
    const names = [
      "010__010.jpg",
      "001__001.jpg",
      "009__009.jpg",
      "100__100.jpg",
      "002__002.jpg",
    ];
    expect(sortNatural(names, (n) => n).slice(0, 3)).toEqual([
      "001__001.jpg",
      "002__002.jpg",
      "009__009.jpg",
    ]);
  });

  it("img2 < img10（字典序会反）", () => {
    expect(naturalCompare("img2.jpg", "img10.jpg")).toBeLessThan(0);
  });

  it("双语对照包 `_A` / `_A_CN` 相邻且 A 在前", () => {
    expect(
      naturalCompare("YeShunguang01_A.png", "YeShunguang01_A_CN.jpg"),
    ).toBeLessThan(0);
    expect(
      naturalCompare("YeShunguang02_A.png", "YeShunguang10_A.png"),
    ).toBeLessThan(0);
  });
});
