export type ProfilePatch = {
  displayName?: string;
  interest?: string;
  identity?: string;
  toneNote?: string;
  replyPreference?: string;
  freeformNote?: string;
};

const CONCISE_REPLY_PREF_RE =
  /不要.*(?:标题|摘要|长篇大论|废话|口水话|总结)|(?:简洁|精简|直接点|短一点|一句话|一两句|别展开|长话短说|太长不看|少点废话|口语化短句|像聊天一样|像真人朋友聊天)/i;

const ADAPTIVE_REPLY_PREF_RE =
  /(?:跟着|顺着).*(?:风格|习惯|方式)|越聊越熟|熟一点|自然一点|像朋友一点|别太官方|别像客服|别像机器人/i;

const LIVELY_TONE_PREF_RE =
  /(?:活人感|像真人|真实一点|有点人味|别太端着|别太正经|自然一点|会聊天一点|口语化一点|顺着聊|陪我聊|追问|多问一句|搞笑|幽默|逗一点|皮一点|俏皮|可爱一点|卖萌|调侃|吐槽|内涵|阴阳|损我两句)/i;

const NAME_RE =
  /(?:我叫|叫我|称呼我|我是|你可以叫我)\s*([^\s，。！？,.]{1,16})/;
const INTEREST_RE =
  /(?:我喜欢|我爱|我最爱|经常|平时喜欢)\s*([^\s，。！？,.]{2,40})/;
const IDENTITY_RE =
  /我是\s*([^\s，。！？,.]{2,24}(?:人|的|者|员|生|师|狗|党)?)/;

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

  if (/(幽默|搞笑|轻松|正式|严谨|温柔|温暖|亲切|俏皮|可爱|活人感)/i.test(t)) {
    patches.push({ toneNote: t.slice(0, 120) });
  }

  if (CONCISE_REPLY_PREF_RE.test(t)) {
    patches.push({
      replyPreference:
        "默认短句、口语化、少解释，像熟人回话；不要客服腔、标题党、表格感和长篇总结。",
    });
  }

  if (ADAPTIVE_REPLY_PREF_RE.test(t)) {
    patches.push({
      freeformNote:
        "回复要继续顺着用户自己的说话方式微调，不套固定模板，整体保持自然、克制、灵活。",
    });
  }

  if (LIVELY_TONE_PREF_RE.test(t)) {
    patches.push({
      freeformNote:
        "用户接受更有活人感的表达：可以视关系和上下文加入幽默、俏皮、轻微调侃、情绪色彩或短追问，但不要固定扮演某种人格。",
    });
  }

  if (/记住|别忘了|以后都要|之后都要/.test(t) && t.length <= 200) {
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
  const filtered = lines.filter((line) => !line.trim().startsWith(`- ${prefix}`));
  filtered.push(`- ${bullet}`);
  return filtered.join("\n").trim();
}

function patchSection(md: string, heading: string, mutator: (body: string) => string): string {
  const re = new RegExp(`(## ${heading}\\s*\\n)([\\s\\S]*?)(?=\\n## |$)`);
  const match = re.exec(md);
  if (!match) return md;
  const nextBody = mutator(match[2].trim());
  return md.slice(0, match.index) + match[1] + nextBody + "\n\n" + md.slice(match.index + match[0].length);
}

export function applyProfilePatches(md: string, patches: ProfilePatch[]): string {
  if (patches.length === 0) return md;
  let out = md;

  const stamp = new Date().toISOString();
  out = out.replace(
    /> 本文件由 Agent[\s\S]*?最后更新：[^\n]*/,
    `> 本文件由 Agent 在与你的对话中持续更新。最后更新：${stamp}`,
  );

  for (const patch of patches) {
    if (patch.displayName) {
      out = patchSection(out, "基本信息", (body) =>
        replaceBulletPrefix(body, "称呼：", `称呼：${patch.displayName}`),
      );
    }
    if (patch.identity) {
      out = patchSection(out, "基本信息", (body) =>
        upsertBullet(body, `身份/背景：${patch.identity}`),
      );
    }
    if (patch.interest) {
      out = patchSection(out, "兴趣与习惯", (body) =>
        upsertBullet(body, `兴趣：${patch.interest}`),
      );
    }
    if (patch.toneNote) {
      out = patchSection(out, "沟通偏好", (body) =>
        upsertBullet(body, `用户曾表达：${patch.toneNote}`),
      );
    }
    if (patch.replyPreference) {
      out = patchSection(out, "沟通偏好", (body) =>
        replaceBulletPrefix(body, "回复偏好：", `回复偏好：${patch.replyPreference}`),
      );
    }
    if (patch.freeformNote) {
      out = patchSection(out, "备注", (body) => upsertBullet(body, patch.freeformNote!));
    }
  }

  return out;
}

export function syncPreferredToneInProfile(md: string, toneLabel: string): string {
  return patchSection(md, "沟通偏好", (body) =>
    replaceBulletPrefix(body, "语气风格：", `语气风格：${toneLabel}（系统会根据对话自动调整）`),
  );
}
