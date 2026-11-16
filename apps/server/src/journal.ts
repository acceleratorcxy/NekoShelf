/**
 * 写回日志。每次写盘动作（整理重命名 / NFO 写入 / 合并标记）都落一份
 * 可读 JSON 到 `<CONFIG_DIR>/journal/<id>.json`，支持列出与撤销。
 *
 * 设计：journal 是「撤销凭据」而不是备份——只记录动作与路径，不复制文件内容。
 */
import type { Db } from "@nekoshelf/core";
import { unmergeWorks } from "@nekoshelf/core";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface OrganizeJournalItem {
  workId: number;
  from: string;
  to: string;
  ok: boolean;
  error?: string;
}

export type JournalEntry =
  | {
      type: "organize";
      at: string;
      pattern: string;
      items: OrganizeJournalItem[];
    }
  | {
      type: "nfo";
      at: string;
      files: string[];
      workIds: number[];
    }
  | {
      type: "merge";
      at: string;
      keepId: number;
      dropIds: number[];
    };

export interface JournalSummary {
  id: string;
  type: string;
  at: string;
  detail: string;
}

function journalDir(configDir: string): string {
  return join(configDir, "journal");
}

export async function writeJournal(configDir: string, id: string, entry: JournalEntry): Promise<string> {
  const dir = journalDir(configDir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.json`);
  await writeFile(file, `${JSON.stringify({ id, ...entry }, null, 2)}\n`);
  return file;
}

function summarize(id: string, entry: JournalEntry & { id?: string }): JournalSummary {
  const at = entry.at;
  if (entry.type === "organize") {
    const ok = entry.items.filter((item) => item.ok).length;
    return { id, type: "整理重命名", at, detail: `${ok}/${entry.items.length} 项成功` };
  }
  if (entry.type === "nfo") {
    return { id, type: "NFO 写入", at, detail: `${entry.files.length} 个文件` };
  }
  return { id, type: "重复合并", at, detail: `保留 #${entry.keepId}，合并 ${entry.dropIds.length} 份` };
}

export async function listJournal(configDir: string, limit = 50): Promise<JournalSummary[]> {
  const dir = journalDir(configDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = names.filter((name) => name.endsWith(".json")).sort().reverse().slice(0, limit);
  const out: JournalSummary[] = [];
  for (const name of files) {
    try {
      const entry = JSON.parse(await readFile(join(dir, name), "utf8")) as JournalEntry & { id?: string };
      out.push(summarize(name.replace(/\.json$/, ""), entry));
    } catch {
      // 损坏的 journal 忽略，不影响其它记录
    }
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 撤销一条 journal：NFO 删除、整理反向改名、合并清标记。源文件规则：只还原，不新增覆盖。 */
export async function undoJournal(
  configDir: string,
  db: Db,
  id: string,
): Promise<{ undone: number; rescanRequired: boolean; type: string }> {
  const file = join(journalDir(configDir), `${id}.json`);
  const entry = JSON.parse(await readFile(file, "utf8")) as JournalEntry;
  let undone = 0;
  let rescanRequired = false;
  if (entry.type === "nfo") {
    for (const target of entry.files) {
      await rm(target, { force: true }).then(
        () => {
          undone += 1;
        },
        () => undefined,
      );
    }
  } else if (entry.type === "organize") {
    // 逆序还原，减少中间态冲突
    for (const item of [...entry.items].reverse()) {
      if (!item.ok) continue;
      try {
        if (!(await exists(item.to))) continue;
        if (await exists(item.from)) continue;
        await rename(item.to, item.from);
        undone += 1;
        rescanRequired = true;
      } catch {
        // 单个失败不阻断其它项
      }
    }
  } else {
    undone = unmergeWorks(db, entry.dropIds).restored;
    rescanRequired = undone > 0;
  }
  await rm(file, { force: true });
  return { undone, rescanRequired, type: entry.type };
}
