import type { SkillMetadata } from "../skills/types.js";

/**
 * 将轨迹升格草稿 JSON（`TrajectoryCapture` 写入）映射为可被 `SkillValidator.validateMetadata`
 * 通过的 **临时** `SkillMetadata`（占位 `auto.promoted_<trace>`，不重名概率高）。
 */
export function skillMetadataFromTrajectoryDraft(
  draft: Record<string, unknown>,
  traceDigest: string,
): SkillMetadata {
  const slug = /^[a-f0-9]+$/i.test(traceDigest) ? traceDigest.slice(0, 14).toLowerCase() : `t${traceDigest.slice(0, 12)}`.toLowerCase();
  const rawTitle =
    typeof draft.title === "string" && draft.title.trim() ?
      draft.title.trim()
    : `轨迹升格 ${traceDigest}`;
  const rawDesc =
    typeof draft.description === "string" && draft.description.trim() ?
      draft.description.trim()
    : "由运行时轨迹整理的占位描述——用于自动化校验占位，发布后请人工完善 SKILL。";
  let description = `${rawDesc}（trace:${traceDigest}）`;
  if (description.length < 10) {
    description = `${description}————————`;
  }

  return {
    name: `auto.promoted_${slug.replace(/[^a-z0-9_]/g, "_")}`,
    version: "1.0.0",
    displayName: rawTitle.slice(0, 120),
    description: description.slice(0, 4000),
    kind: "community",
    tags: typeof draft.toolSequenceHint === "object" && Array.isArray(draft.toolSequenceHint) ?
      ["trajectory-draft", ...draft.toolSequenceHint.filter((x): x is string => typeof x === "string").slice(0, 8)]
    : ["trajectory-draft"],
    parameters: [
      {
        name: "context",
        type: "string",
        required: false,
        description: "可选上下文（升格占位参数）",
      },
    ],
    permissions: [],
    author:
      typeof draft.hermes_reflect === "string" && draft.hermes_reflect.trim() ?
        `hermes-auto:${draft.hermes_reflect.slice(0, 80)}`
      : "trajectory-promotion-pipeline",
  };
}
