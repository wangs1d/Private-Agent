/**
 * 召回 golden 评测夹具：固定中文记忆语料 + query 分级相关度标注。
 *
 * 与 test/memory-recall-benchmark.test.ts（通道行为基准）互补：本夹具回答
 * 「融合排序对固定语料是否准」——为 FTS 第三路 / RRF 融合 / 精排改动提供
 * MRR@8 / Recall@5 / NDCG@5 回归基线（见 test/memory-recall-fusion.test.ts）。
 *
 * 标注约定：rel=2 直接回答 query；rel=1 有助回答（相关背景）。
 */

export interface GoldenMemory {
  id: string;
  content: string;
}

export interface GoldenQuery {
  query: string;
  /** memoryId → 分级相关度（2=直接回答，1=相关背景） */
  relevance: Record<string, number>;
}

export const GOLDEN_CORPUS: GoldenMemory[] = [
  { id: "m01", content: "用户的前端技术栈是 TypeScript 和 React" },
  { id: "m02", content: "用户住在杭州，去年从上海搬来" },
  { id: "m03", content: "用户的猫叫布丁，是一只英短" },
  { id: "m04", content: "用户正在开发私人助理项目，后端用 Node.js" },
  { id: "m05", content: "用户每周六早上会去西湖边跑步" },
  { id: "m06", content: "用户对花生过敏，外出就餐会特别确认配料" },
  { id: "m07", content: "用户的公司在滨江，做跨境电商业务" },
  { id: "m08", content: "用户计划明年三月考 PMP 项目管理认证" },
  { id: "m09", content: "用户不喜欢甜咖啡，习惯喝美式" },
  { id: "m10", content: "用户的妻子是中学语文老师" },
  { id: "m11", content: "用户使用 Qdrant 做向量检索，用 Mem0 管理长期记忆" },
  { id: "m12", content: "用户每晚十一点前睡觉，早上七点起床" },
  { id: "m13", content: "用户的生日是 3 月 14 日" },
  { id: "m14", content: "用户最近在自学 Rust，想写命令行工具" },
];

export const GOLDEN_QUERIES: GoldenQuery[] = [
  { query: "前端用什么语言", relevance: { m01: 2, m04: 1 } },
  { query: "住在哪个城市", relevance: { m02: 2 } },
  { query: "那只英短叫什么", relevance: { m03: 2 } },
  { query: "私人助理后端选了什么", relevance: { m04: 2, m11: 1 } },
  { query: "PMP 认证什么时候考", relevance: { m08: 2 } },
  { query: "向量检索用的是什么组件", relevance: { m11: 2, m04: 1 } },
  { query: "有什么食物过敏吗", relevance: { m06: 2, m09: 1 } },
  { query: "最近在学什么新语言", relevance: { m14: 2, m01: 1 } },
];
