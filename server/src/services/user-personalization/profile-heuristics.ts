export type ProfilePatch = {
  displayName?: string;
  interest?: string;
  identity?: string;
  toneNote?: string;
  replyPreference?: string;
  freeformNote?: string;
};

const CONCISE_REPLY_PREF_RE =
  /不要.*(?:等级|标题|摘要|长篇大论|废话|口水话)|(?:等级|标题|摘要).*(?:不要|别出现|什么的)|简洁.*(?:回答|回复)|精简直接|口语化.*短句|别太啰嗦|别废话|少点废话|短一点|说人话|像聊天一样|像真人朋友聊天/;

const ADAPTIVE_REPLY_PREF_RE =
  /跟着.*(?:风格|习惯|方式)|越来?越熟|熟一点|自然一点|像朋友一点|别太官方|别像客服|别像机器人/;

const NAME_RE = /(?:我叫|叫我|称呼我|我是|你可以叫我)([^\s，。！？,\.]{1,16})/;
const INTEREST_RE = /(?:我喜欢|我爱|我最爱|经常|平时喜欢)([^\s，。！？,\.]{2,40})/;
const IDENTITY_RE = /我是([^\s，。！？,\.]{2,20}(?:人|的|者|党|派|类)?)/;

export function extractProfilePatches(userText: string): ProfilePatch[] {
  const t = userText.trim();
  if (!t) return [];

  const patches: ProfilePatch[] = [];

  const name = NAME_RE.exec(t);
  if (name?.[1]) patches.push({ displayName: name[1].trim() });

  const interest = INTEREST_RE.exec(t);
  if (interest?.[1]) patches.push({ interest: interest[1].trim() });

  const identity = IDENTITY_RE.exec(t);
  if (identity?.[1]) patches.push({ identity: identity[1].trim() });

  if (/幽默|搞笑|轻松|正式|严肃|温馨|温柔|亲切/.test(t)) {
    patches.push({ toneNote: t.slice(0, 80) });
  }

  if (CONCISE_REPLY_PREF_RE.test(t)) {
    patches.push({
      replyPreference: "默认短句、口语化、少解释，像熟人回话；不要客服腔、标题、表格和长篇总结。",
    });
  }

  if (ADAPTIVE_REPLY_PREF_RE.test(t)) {
    patches.push({
      freeformNote: "回复继续跟着用户自己的说话方式微调，不套固定模板，整体保持自然、克制、精简。",
    });
  }

  if (/记住|别忘了|以后都要/.test(t) && t.length <= 200) {
    patches.push({ freeformNote: t.slice(0, 120) });
  }

  return patches;
}

function upsertBullet(sectionBody: string, bullet: string): string {
  const line = `- ${bullet}`;
  if (sectionBody.includes(bullet)) return sectionBody;
  const trimmed = sectionBody.trimEnd();
  return trimmed ? `${trimmed}\n${line}` : line;
}

function replaceBulletPrefix(sectionBody: string, prefix: string, bullet: string): string {
  const lines = sectionBody.split("\n");
  const filtered = lines.filter((l) => !l.trim().startsWith(`- ${prefix}`));
  filtered.push(`- ${bullet}`);
  return filtered.join("\n").trim();
}

function patchSection(md: string, heading: string, mutator: (body: string) => string): string {
  const re = new RegExp(`(## ${heading}\\s*\\n)([\\s\\S]*?)(?=\\n## |$)`);
  const m = re.exec(md);
  if (!m) return md;
  const nextBody = mutator(m[2].trim());
  return md.slice(0, m.index) + m[1] + nextBody + "\n\n" + md.slice(m.index + m[0].length);
}

export function applyProfilePatches(md: string, patches: ProfilePatch[]): string {
  if (patches.length === 0) return md;
  let out = md;

  const stamp = new Date().toISOString();
  out = out.replace(
    /> 本文件由 Agent[\s\S]*?最后更新：[^\n]*/,
    `> 本文件由 Agent 在与你的对话中持续更新。最后更新：${stamp}`,
  );

  for (const p of patches) {
    if (p.displayName) {
      out = patchSection(out, "基本信息", (body) =>
        replaceBulletPrefix(body, "称呼：", `称呼：${p.displayName}`),
      );
    }
    if (p.identity) {
      out = patchSection(out, "基本信息", (body) =>
        upsertBullet(body, `身份/背景：${p.identity}`),
      );
    }
    if (p.interest) {
      out = patchSection(out, "兴趣与习惯", (body) =>
        upsertBullet(body, `兴趣：${p.interest}`),
      );
    }
    if (p.toneNote) {
      out = patchSection(out, "沟通偏好", (body) =>
        upsertBullet(body, `用户曾表达：${p.toneNote}`),
      );
    }
    if (p.replyPreference) {
      out = patchSection(out, "沟通偏好", (body) =>
        replaceBulletPrefix(body, "回复偏好：", `回复偏好：${p.replyPreference}`),
      );
    }
    if (p.freeformNote) {
      out = patchSection(out, "备注", (body) => upsertBullet(body, p.freeformNote!));
    }
  }

  return out;
}

export function syncPreferredToneInProfile(md: string, toneLabel: string): string {
  return patchSection(md, "沟通偏好", (body) =>
    replaceBulletPrefix(body, "语气风格：", `语气风格：${toneLabel}（系统根据对话自动调整）`),
  );
}
