/**
 * MemorySchemaFormation 单元测试。
 *
 * 覆盖 14 个场景：
 *   1. extractSchema：节点数 < 3 时返回 null
 *   2. extractSchema：节点数 >= 3 时抽取图式
 *   3. extractSchema：steps 提取正确（用 LCS 算法）
 *   4. extractSchema：preconditions 从 entityTags 提取
 *   5. extractSchema：expectedOutcomes 从 emotionTags 提取
 *   6. extractSchema：instances 包含所有源节点 id
 *   7. matchSchema：sceneTag 相同返回高分匹配
 *   8. matchSchema：keywords overlap 计算匹配分
 *   9. matchSchema：所有匹配分 < 阈值返回 null
 *   10. matchSchema：stereotypeWarningCount > 3 时 hasStereotypeWarning=true
 *   11. recordStereotypeFailure：stereotypeWarningCount 自增
 *   12. recordStereotypeFailure：schemaId 不存在时不报错
 *   13. humanLike 为 null 时 extractSchema 返回 null
 *   14. 降级开关：BRAIN_MEMORY_SCHEMA_ENABLED=0 时方法空操作
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MemorySchemaFormation,
  type HumanLikeMemorySchemaLike,
} from "../src/brain/memory-cognitive/memory-schema-formation.js";

// ---- helpers ------------------------------------------------------------

/** Schema 节点 mock 类型 */
type SchemaMockNode = {
  id: string;
  summary: string;
  keywords: string[];
  sceneTags: string[];
  entityTags: string[];
  emotionTags: string[];
  metadata?: Record<string, unknown>;
};

/** 构造 mock HumanLikeMemorySchemaLike */
function makeMockHumanLike(nodesBySceneTag: Record<string, SchemaMockNode[]>): HumanLikeMemorySchemaLike {
  return {
    getNodesBySceneTag(actorId: string, sceneTag: string): SchemaMockNode[] {
      const key = `${actorId}::${sceneTag}`;
      return nodesBySceneTag[key] ?? [];
    },
  };
}

/** 临时设置环境变量，测试结束后恢复 */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 构造 3 个餐厅场景的 mock 节点（用于 extractSchema 测试） */
function makeRestaurantNodes(): SchemaMockNode[] {
  return [
    {
      id: "ep-1",
      summary: "进门→点餐→吃→结账",
      keywords: ["餐厅", "吃饭"],
      sceneTags: ["餐厅"],
      entityTags: ["桌号", "菜单", "服务员"],
      emotionTags: ["满足", "饱腹"],
      metadata: { outcomes: ["吃饱", "付钱"] },
    },
    {
      id: "ep-2",
      summary: "进门→点餐→吃→付款",
      keywords: ["餐厅", "用餐"],
      sceneTags: ["餐厅"],
      entityTags: ["桌号", "菜单"],
      emotionTags: ["满足", "满意"],
      metadata: { outcomes: ["吃饱"] },
    },
    {
      id: "ep-3",
      summary: "进门→点餐→吃→结账",
      keywords: ["餐厅"],
      sceneTags: ["餐厅"],
      entityTags: ["桌号", "菜单", "服务员"],
      emotionTags: ["满足", "饱腹", "满意"],
      metadata: { outcomes: ["吃饱", "付钱"] },
    },
  ];
}

// ---- 场景 1: 节点数 < 3 时返回 null ----------------------------------------

test("场景 1: extractSchema 节点数 < 3 时返回 null", async () => {
  const humanLike = makeMockHumanLike({
    "user-1::餐厅": [
      { id: "ep-1", summary: "进门→点餐", keywords: [], sceneTags: [], entityTags: [], emotionTags: [] },
      { id: "ep-2", summary: "进门→点餐", keywords: [], sceneTags: [], entityTags: [], emotionTags: [] },
    ],
  });
  const formation = new MemorySchemaFormation({ humanLike });
  const schema = await formation.extractSchema("user-1", "餐厅");
  assert.equal(schema, null);
});

// ---- 场景 2: 节点数 >= 3 时抽取图式 -----------------------------------------

test("场景 2: extractSchema 节点数 >= 3 时抽取图式", async () => {
  const humanLike = makeMockHumanLike({
    "user-1::餐厅": makeRestaurantNodes(),
  });
  const formation = new MemorySchemaFormation({ humanLike });
  const schema = await formation.extractSchema("user-1", "餐厅");
  assert.ok(schema, "应返回非 null 图式");
  assert.equal(schema!.name, "餐厅图式");
  assert.equal(schema!.sceneTag, "餐厅");
  assert.equal(schema!.stereotypeWarningCount, 0);
  assert.ok(schema!.id.startsWith("schema:餐厅:"));
  assert.ok(schema!.createdAt);
  assert.ok(schema!.updatedAt);
});

// ---- 场景 3: steps 提取正确（用 LCS 算法） -----------------------------------

test("场景 3: extractSchema steps 提取正确（LCS 算法）", async () => {
  const humanLike = makeMockHumanLike({
    "user-1::餐厅": makeRestaurantNodes(),
  });
  const formation = new MemorySchemaFormation({ humanLike });
  const schema = await formation.extractSchema("user-1", "餐厅");
  assert.ok(schema);
  // LCS 阈值 = ceil(3/2) = 2，频次阈值 0.5 → minCount = ceil(3*0.5) = 2
  // "进门" 出现 3 次, "点餐" 3 次, "吃" 3 次, "结账" 2 次, "付款" 1 次
  // 保留: 进门, 点餐, 吃, 结账 ;  排除: 付款
  assert.deepEqual(schema!.steps, ["进门", "点餐", "吃", "结账"]);
});

// ---- 场景 4: preconditions 从 entityTags 提取 -------------------------------

test("场景 4: extractSchema preconditions 从 entityTags 提取", async () => {
  const humanLike = makeMockHumanLike({
    "user-1::餐厅": makeRestaurantNodes(),
  });
  const formation = new MemorySchemaFormation({ humanLike });
  const schema = await formation.extractSchema("user-1", "餐厅");
  assert.ok(schema);
  // entityTags 频次: 桌号=3, 菜单=3, 服务员=2
  // 前 3 高频应包含这三个（顺序按频次降序）
  assert.equal(schema!.preconditions.length, 3);
  assert.ok(schema!.preconditions.includes("桌号"));
  assert.ok(schema!.preconditions.includes("菜单"));
  assert.ok(schema!.preconditions.includes("服务员"));
});

// ---- 场景 5: expectedOutcomes 从 emotionTags 提取 ----------------------------

test("场景 5: extractSchema expectedOutcomes 从 emotionTags 提取", async () => {
  const humanLike = makeMockHumanLike({
    "user-1::餐厅": makeRestaurantNodes(),
  });
  const formation = new MemorySchemaFormation({ humanLike });
  const schema = await formation.extractSchema("user-1", "餐厅");
  assert.ok(schema);
  // emotionTags + metadata.outcomes 频次:
  //   满足=3, 饱腹=2, 满意=2, 吃饱=3, 付钱=2
  // 前 3 高频应从这些中取（满足=3, 吃饱=3, 然后是 2 次的若干个）
  assert.equal(schema!.expectedOutcomes.length, 3);
  // 满足(3次) 和 吃饱(3次) 必在前 3
  assert.ok(schema!.expectedOutcomes.includes("满足"));
  assert.ok(schema!.expectedOutcomes.includes("吃饱"));
});

// ---- 场景 6: instances 包含所有源节点 id ------------------------------------

test("场景 6: extractSchema instances 包含所有源节点 id", async () => {
  const humanLike = makeMockHumanLike({
    "user-1::餐厅": makeRestaurantNodes(),
  });
  const formation = new MemorySchemaFormation({ humanLike });
  const schema = await formation.extractSchema("user-1", "餐厅");
  assert.ok(schema);
  assert.deepEqual(schema!.instances.sort(), ["ep-1", "ep-2", "ep-3"]);
});

// ---- 场景 7: matchSchema sceneTag 相同返回高分匹配 --------------------------

test("场景 7: matchSchema sceneTag 相同返回高分匹配", async () => {
  const humanLike = makeMockHumanLike({
    "user-1::餐厅": makeRestaurantNodes(),
  });
  const formation = new MemorySchemaFormation({ humanLike });
  await formation.extractSchema("user-1", "餐厅");

  const result = formation.matchSchema({ sceneTag: "餐厅" });
  assert.ok(result, "应返回匹配结果");
  assert.equal(result!.matchScore, 0.6);
  assert.equal(result!.hasStereotypeWarning, false);
  assert.equal(result!.schema.sceneTag, "餐厅");
});

// ---- 场景 8: matchSchema keywords overlap 计算匹配分 ------------------------

test("场景 8: matchSchema keywords overlap 计算匹配分", async () => {
  const humanLike = makeMockHumanLike({
    "user-1::餐厅": makeRestaurantNodes(),
  });
  const formation = new MemorySchemaFormation({ humanLike });
  await formation.extractSchema("user-1", "餐厅");

  // schema: preconditions=["桌号","菜单","服务员"], steps=["进门","点餐","吃","结账"]
  // target = 7 项; keywords 命中 4 项 → score = 4/7 ≈ 0.571
  const result = formation.matchSchema({
    keywords: ["桌号", "菜单", "点餐", "吃", "未知词"],
  });
  assert.ok(result, "应返回匹配结果");
  assert.ok(result!.matchScore > 0.3, `matchScore 应 > 0.3, 实际 ${result!.matchScore}`);
  assert.ok(result!.matchScore < 0.6, `matchScore 应 < 0.6（非 sceneTag 匹配）, 实际 ${result!.matchScore}`);
});

// ---- 场景 9: matchSchema 所有匹配分 < 阈值返回 null -------------------------

test("场景 9: matchSchema 所有匹配分 < 阈值返回 null", async () => {
  const humanLike = makeMockHumanLike({
    "user-1::餐厅": makeRestaurantNodes(),
  });
  const formation = new MemorySchemaFormation({ humanLike });
  await formation.extractSchema("user-1", "餐厅");

  // 用完全不相关的 keywords，overlap = 0
  const result = formation.matchSchema({
    keywords: ["完全无关的词", "另一个无关词"],
  });
  assert.equal(result, null);
});

// ---- 场景 10: stereotypeWarningCount > 3 时 hasStereotypeWarning=true -------

test("场景 10: matchSchema stereotypeWarningCount > 3 时 hasStereotypeWarning=true", async () => {
  const humanLike = makeMockHumanLike({
    "user-1::餐厅": makeRestaurantNodes(),
  });
  const formation = new MemorySchemaFormation({ humanLike });
  const schema = await formation.extractSchema("user-1", "餐厅");
  assert.ok(schema);

  // 连续 4 次失败（> 阈值 3）
  formation.recordStereotypeFailure(schema!.id);
  formation.recordStereotypeFailure(schema!.id);
  formation.recordStereotypeFailure(schema!.id);
  formation.recordStereotypeFailure(schema!.id);

  const result = formation.matchSchema({ sceneTag: "餐厅" });
  assert.ok(result);
  assert.equal(result!.hasStereotypeWarning, true);
});

// ---- 场景 11: recordStereotypeFailure 自增 ----------------------------------

test("场景 11: recordStereotypeFailure stereotypeWarningCount 自增", async () => {
  const humanLike = makeMockHumanLike({
    "user-1::餐厅": makeRestaurantNodes(),
  });
  const formation = new MemorySchemaFormation({ humanLike });
  const schema = await formation.extractSchema("user-1", "餐厅");
  assert.ok(schema);
  assert.equal(schema!.stereotypeWarningCount, 0);

  formation.recordStereotypeFailure(schema!.id);
  const after1 = formation.getSchema(schema!.id);
  assert.ok(after1);
  assert.equal(after1!.stereotypeWarningCount, 1);

  formation.recordStereotypeFailure(schema!.id);
  const after2 = formation.getSchema(schema!.id);
  assert.ok(after2);
  assert.equal(after2!.stereotypeWarningCount, 2);
});

// ---- 场景 12: recordStereotypeFailure schemaId 不存在时不报错 ----------------

test("场景 12: recordStereotypeFailure schemaId 不存在时不报错", async () => {
  const formation = new MemorySchemaFormation();
  // 不应抛出异常
  assert.doesNotThrow(() => {
    formation.recordStereotypeFailure("不存在的-schema-id");
  });
});

// ---- 场景 13: humanLike 为 null 时 extractSchema 返回 null ------------------

test("场景 13: humanLike 为 null 时 extractSchema 返回 null", async () => {
  const formation = new MemorySchemaFormation();
  const schema = await formation.extractSchema("user-1", "餐厅");
  assert.equal(schema, null);
});

// ---- 场景 14: 降级开关 BRAIN_MEMORY_SCHEMA_ENABLED=0 时空操作 ----------------

test("场景 14: 降级开关 BRAIN_MEMORY_SCHEMA_ENABLED=0 时空操作", async () => {
  await withEnv({ BRAIN_MEMORY_SCHEMA_ENABLED: "0" }, async () => {
    const humanLike = makeMockHumanLike({
      "user-1::餐厅": makeRestaurantNodes(),
    });
    const formation = new MemorySchemaFormation({ humanLike });

    // extractSchema 应返回 null
    const schema = await formation.extractSchema("user-1", "餐厅");
    assert.equal(schema, null);

    // matchSchema 应返回 null
    const match = formation.matchSchema({ sceneTag: "餐厅" });
    assert.equal(match, null);

    // recordStereotypeFailure 不应抛错
    assert.doesNotThrow(() => {
      formation.recordStereotypeFailure("any-id");
    });
  });
});

// ---- 补充: getAllSchemas 按 actorId 过滤 ------------------------------------

test("补充: getAllSchemas 按 actorId 过滤", async () => {
  const humanLike = makeMockHumanLike({
    "user-1::餐厅": makeRestaurantNodes(),
    "user-2::咖啡厅": [
      { id: "c-1", summary: "进门→点单→取餐", keywords: [], sceneTags: [], entityTags: [], emotionTags: [] },
      { id: "c-2", summary: "进门→点单→取餐", keywords: [], sceneTags: [], entityTags: [], emotionTags: [] },
      { id: "c-3", summary: "进门→点单→取餐", keywords: [], sceneTags: [], entityTags: [], emotionTags: [] },
    ],
  });
  const formation = new MemorySchemaFormation({ humanLike });
  await formation.extractSchema("user-1", "餐厅");
  await formation.extractSchema("user-2", "咖啡厅");

  const all = formation.getAllSchemas();
  assert.equal(all.length, 2);

  const user1Only = formation.getAllSchemas("user-1");
  assert.equal(user1Only.length, 1);
  assert.equal(user1Only[0].sceneTag, "餐厅");

  const user2Only = formation.getAllSchemas("user-2");
  assert.equal(user2Only.length, 1);
  assert.equal(user2Only[0].sceneTag, "咖啡厅");
});
