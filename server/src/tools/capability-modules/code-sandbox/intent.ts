/**
 * code-sandbox 工具意图元数据 + 关键词分类映射。
 *
 * `CODE_SANDBOX_INTENT_RULES` 与 `intent-metadata.ts` 中 `DEFAULT_TOOL_INTENT_RULES`
 * 同结构（`ToolIntentRule`），通过 `setExtraIntentRules` 在启动时合并到全局规则表，
 * 供 tool-search BM25 排序调权。
 *
 * `CODE_SANDBOX_CATEGORY_MAPPING` 供 `openai-compatible-tool-loop.ts` 的
 * `TOOL_CATEGORY_MAPPINGS` 合并：命中关键词时把本模块全部工具名注入到候选分类。
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const CODE_SANDBOX_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "code.",
    metadata: {
      aliases: [
        "code", "run code", "execute code", "script", "python", "node",
        "sandbox", "repl", "jupyter", "运行代码", "执行代码", "跑代码",
        "脚本", "沙箱", "沙盒", "代码块", "公式", "方程", "矩阵", "统计",
        "可视化", "plot", "matplotlib", "pandas", "numpy",
      ],
      negativeAliases: [
        "image", "picture", "draw", "paint", "phone call", "calendar reminder",
        "wallet transfer", "画图", "打电话", "开灯",
      ],
      examples: [
        "跑一段 python 算一下",
        "写个脚本处理这个 csv",
        "用 matplotlib 画个折线图",
        "run this python snippet",
      ],
      negativeExamples: [
        "画一张猫的图",
        "给我打个电话",
        "把灯关了",
      ],
    },
  },
  {
    exact: "code.run",
    metadata: {
      aliases: [
        "run code", "execute code", "run python", "run node", "execute script",
        "run script", "eval code", "compute", "calculate",
        "运行代码", "执行代码", "跑代码", "执行脚本", "运行脚本", "算一下",
        "计算一下", "跑个脚本", "写段代码",
      ],
      examples: [
        "用 python 算一下这个矩阵的逆",
        "写个 node 脚本批量重命名",
        "跑这段代码看看输出",
        "run this snippet and show me the output",
      ],
      negativeExamples: [
        "读一下这个文件",
        "列出工作目录文件",
      ],
    },
  },
  {
    exact: "code.list_files",
    metadata: {
      aliases: [
        "list files", "list workspace", "show files", "workspace files",
        "列出文件", "工作目录文件", "看下生成了哪些文件",
      ],
      examples: [
        "列出工作目录的文件",
        "看看脚本生成了哪些文件",
        "list files in the workspace",
      ],
      negativeExamples: [
        "运行这段代码",
        "读取这个文件",
      ],
    },
  },
  {
    exact: "code.read_file",
    metadata: {
      aliases: [
        "read file", "view file", "open file", "show file content",
        "读取文件", "读文件", "看文件内容", "打开工作目录文件",
      ],
      examples: [
        "读取工作目录下的 output.csv",
        "看看生成的 result.json 内容",
        "read the generated file",
      ],
      negativeExamples: [
        "运行这段代码",
        "列出工作目录文件",
      ],
    },
  },
  {
    exact: "code.write_file",
    metadata: {
      aliases: [
        "write file", "save file", "create file", "store file",
        "写入文件", "保存文件", "存成文件", "写入工作目录",
      ],
      examples: [
        "把这段数据写入工作目录的 data.csv",
        "保存脚本到工作目录",
        "save this as input.json",
      ],
      negativeExamples: [
        "运行这段代码",
        "读取这个文件",
      ],
    },
  },
];

export const CODE_SANDBOX_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "code_sandbox",
  keywords: [
    // 中英关键词，覆盖用户口语
    "code", "run", "execute", "python", "node", "script", "sandbox", "repl",
    "compute", "calculate", "formula", "matrix", "statistics",
    "plot", "matplotlib", "pandas", "numpy", "jupyter",
    "代码", "运行", "执行", "跑", "脚本", "沙箱", "沙盒",
    "公式", "方程", "矩阵", "统计", "算法", "数据",
    "可视化", "计算",
  ],
};
