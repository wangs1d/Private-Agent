# 更新 recommendation-runtime-e2e.ts：新增个性化场景（假 LLM 注入 + 降级路径断言）
s = open("scripts/recommendation-runtime-e2e.ts", encoding="utf-8").read()

old_register = """const registry: ToolRegistry = new ToolRegistry();
const catalog = createRecommendationCatalog(
  join(process.cwd(), "data", "recommendation"),
);
registerLifeTools(registry, {} as never, {} as never, catalog);"""

new_register = """const registry: ToolRegistry = new ToolRegistry();
const catalog = createRecommendationCatalog(
  join(process.cwd(), "data", "recommendation"),
);

// 可注入的假个性化 LLM（记录收到的画像/数据，返回固定决策 JSON）
let lastPersonalizationPrompt = "";
let fakeLlmRaw: string | null = null;
const personalization = {
  buildUserContext: async (actorId: string, userRequest?: string) => {
    lastPersonalizationPrompt = `actor=${actorId} request=${userRequest ?? ""}`;
    return "用户画像：通勤地铁单程 40 分钟；常用安卓机；偏好实用、对价格敏感";
  },
  llmComplete: fakeLlmRaw
    ? async () => fakeLlmRaw!
    : null,
};

registerLifeTools(registry, {} as never, {} as never, {
  catalog,
  personalization,
});"""
assert old_register in s
s = s.replace(old_register, new_register, 1)

# 场景 1 输入加 userRequest
old_call = """const r1raw = (await execute("shopping.suggest", {
  item: "MAC Chili Dior 720",
})) as { ok: boolean; result: { recommendation?: { candidates: unknown[]; compare?: { rows: unknown[] } } } };"""
new_call = """const r1raw = (await execute("shopping.suggest", {
  item: "MAC Chili Dior 720",
})) as { ok: boolean; result: { recommendation?: { candidates: unknown[]; compare?: { rows: unknown[] } } } };
check("无个性化 LLM 时降级商品库文案", typeof r1raw.result.recommendation === "object");"""
assert old_call in s
s = s.replace(old_call, new_call, 1)

# 末尾追加个性化场景（在"全部通过"之前）
old_tail = """console.log(failed === 0 ? "\\n全部通过 ✓" : `\\n${failed} 项失败 ✗`);"""
new_tail = """// ── 场景 4：有个性化 LLM → 每轮实时决策（重排 + 改写话术 + 画像注入） ──
console.log("\\n[场景4] 个性化实时决策（注入画像 + 假 LLM 决策）");
fakeLlmRaw = JSON.stringify({
  summary: "两支都显白，通勤日常选 Chili 更实用",
  candidates: [
    {
      productId: "p-lip-chili",
      reasons: ["黄皮通勤显白不挑皮，日常办公室压得住", "哑光质地开会补妆一次就够"],
      cautions: ["你常说的唇部干燥问题，务必先打底"],
    },
    {
      productId: "p-lip-dior720",
      reasons: ["约会/正式场合的温柔挂，和你常用的妆容路线互补"],
      cautions: ["持色一般，午餐后需要补"],
    },
  ],
});
const r4raw = (await execute("shopping.suggest", {
  item: "MAC Chili Dior 720",
  userRequest: "这两支二选一，我日常上班为主，黄皮",
})) as {
  ok: boolean;
  result: {
    summary: string;
    personalized?: boolean;
    recommendation?: { candidates: Array<{ productId: string; reasons: string[] }> };
  };
};
const r4 = r4raw.result;
check("个性化被标记为已应用", r4.personalized === true);
check("画像/原话进入了决策提示词", lastPersonalizationPrompt.includes("通勤地铁") && lastPersonalizationPrompt.includes("日常上班"));
check("候选被实时重排", r4.recommendation?.candidates?.[0]?.productId === "p-lip-chili");
check(
  "话术为当轮改写（非商品库模板）",
  (r4.recommendation?.candidates?.[0]?.reasons?.[0] ?? "").includes("黄皮通勤"),
);
check("summary 为 LLM 实时结论", r4.summary.includes("通勤"));

// ── 场景 5：LLM 输出非法 → 确定性兜底 ──
console.log("\\n[场景5] 个性化 LLM 输出非法 → 降级");
fakeLlmRaw = "这不是 JSON";
const r5raw = (await execute("shopping.suggest", { item: "MAC Chili Dior 720" })) as {
  ok: boolean;
  result: { personalized?: boolean; recommendation?: { candidates: unknown[] } };
};
check("非法输出被拒", r5raw.result.personalized === false);
check("降级回商品库文案（候选仍在）", (r5raw.result.recommendation?.candidates?.length ?? 0) >= 2);

console.log(failed === 0 ? "\\n全部通过 ✓" : `\\n${failed} 项失败 ✗`);"""
assert old_tail in s
s = s.replace(old_tail, new_tail, 1)

open("scripts/recommendation-runtime-e2e.ts", "w", encoding="utf-8", newline="\n").write(s)
print("e2e updated")
EOF