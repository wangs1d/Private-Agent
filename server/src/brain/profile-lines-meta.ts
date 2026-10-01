/**
 * 画像行新鲜度元数据（sidecar，2026-09-29 P1-1「越用越准」）。
 *
 * USER_PROFILE.md 是纯 markdown，行级元数据（首次出现/最近证实/出现次数）
 * 落同目录 profile-lines-meta.json。深度合成据此把久未被对话证实的行显式
 * 交给 LLM 裁决（删除或保留），防止陈旧事实（前公司/前任/旧项目）永久占坑。
 *
 * 设计约束：meta 是画像的从属物——画像行消失即回收 meta；meta 丢失/损坏
 * 只影响新鲜度判断，不影响画像本身（rebuild 可从画像全文重建）。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UserProfileStore } from "../services/user-personalization/user-profile-store.js";

const META_FILENAME = "profile-lines-meta.json";

export type ProfileLineMeta = {
  line: string;
  section: string;
  firstSeenAt: string;
  lastConfirmedAt: string;
  seenCount: number;
};

type MetaFile = Record<string, ProfileLineMeta>;

function lineKey(section: string, line: string): string {
  return `${section}::${line.trim()}`;
}

function metaPath(actorId: string): string {
  return join(dirname(new UserProfileStore().profilePath(actorId)), META_FILENAME);
}

async function loadMeta(actorId: string): Promise<MetaFile> {
  try {
    const parsed = JSON.parse(await readFile(metaPath(actorId), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as MetaFile) : {};
  } catch {
    return {};
  }
}

async function saveMeta(actorId: string, meta: MetaFile): Promise<void> {
  const path = metaPath(actorId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(meta), "utf8");
}

type ParsedProfile = { section: string; line: string }[];

/** 解析画像 md → [{section, line}]（只取「- 」内容行，保留原文本） */
export function parseProfileLines(profile: string): ParsedProfile {
  const out: ParsedProfile = [];
  let section = "";
  for (const raw of profile.split("\n")) {
    const t = raw.trim();
    if (t.startsWith("## ")) {
      section = t.slice(3).trim();
      continue;
    }
    if (t.startsWith("- ")) out.push({ section, line: t.slice(2).trim() });
  }
  return out;
}

/**
 * 与画像全文同步元数据并"证实"指定行（每轮 LLM 抽取落位后调用）：
 *  - confirmedLines 命中的行：lastConfirmedAt=now，seenCount+1；
 *  - 画像中存在但 meta 没有的行（用户编辑/首次建账）：补录，firstSeen=now
 *    （保守起点：新行的陈旧判定从现在起算，不会立刻被当陈旧行）；
 *  - 画像中已消失的行：meta 同步回收。
 */
export async function touchProfileLines(
  actorId: string,
  profile: string,
  confirmedLines: string[],
): Promise<void> {
  const meta = await loadMeta(actorId);
  const now = new Date().toISOString();
  const confirmed = new Set(confirmedLines.map((l) => l.trim()).filter(Boolean));
  const seenKeys = new Set<string>();
  for (const { section, line } of parseProfileLines(profile)) {
    const key = lineKey(section, line);
    seenKeys.add(key);
    const prev = meta[key];
    const isConfirmed = confirmed.has(line);
    if (prev) {
      prev.line = line;
      prev.section = section;
      if (isConfirmed) {
        prev.lastConfirmedAt = now;
        prev.seenCount += 1;
      }
    } else {
      meta[key] = {
        line,
        section,
        firstSeenAt: now,
        lastConfirmedAt: now,
        seenCount: isConfirmed ? 1 : 0,
      };
    }
  }
  for (const key of Object.keys(meta)) {
    if (!seenKeys.has(key)) delete meta[key];
  }
  await saveMeta(actorId, meta);
}

/** 深度合成整文重写后调用：保留已有 meta，新行补录，消失行回收 */
export async function rebuildProfileMeta(actorId: string, profile: string): Promise<void> {
  await touchProfileLines(actorId, profile, []);
}

/** 超过 staleMs 未被对话证实的行（深度合成把它们列为裁决候选） */
export async function listStaleLines(
  actorId: string,
  profile: string,
  staleMs: number,
): Promise<ProfileLineMeta[]> {
  const meta = await loadMeta(actorId);
  const now = Date.now();
  const current = new Set(
    parseProfileLines(profile).map(({ section, line }) => lineKey(section, line)),
  );
  return Object.values(meta)
    .filter((m) => {
      const key = lineKey(m.section, m.line);
      if (!current.has(key)) return false;
      const age = now - new Date(m.lastConfirmedAt).getTime();
      return Number.isFinite(age) && age >= staleMs;
    })
    .sort((a, b) => a.lastConfirmedAt.localeCompare(b.lastConfirmedAt));
}

/** 管理页读：全部行元数据（按最近证实倒序） */
export async function readProfileMeta(actorId: string): Promise<ProfileLineMeta[]> {
  return Object.values(await loadMeta(actorId)).sort((a, b) =>
    b.lastConfirmedAt.localeCompare(a.lastConfirmedAt),
  );
}
