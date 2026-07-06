/**
 * file-doc 工具意图元数据 —— 用于 tool-search BM25 排序调权。
 *
 * 与 `intent-metadata.ts` 中 `DEFAULT_TOOL_INTENT_RULES` 同结构；
 * 通过 {@link registerCapabilityModuleIntentRules} 在启动时合并到全局规则表。
 *
 * 覆盖中英关键词：文件 / 解析 / PDF / Word / Excel / 导出 / parse / document / spreadsheet 等。
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const FILE_DOC_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "file.",
    metadata: {
      aliases: [
        "file", "document", "doc", "read file", "read text", "write file",
        "save file", "parse", "parse document", "解析文件", "读文件",
        "写文件", "保存文件", "读取", "导出", "export",
      ],
      negativeAliases: [
        "image", "picture", "draw", "paint", "phone call", "calendar reminder",
        "wallet transfer", "smart home light", "画图", "打电话", "开灯",
      ],
      examples: [
        "读一下这个文件",
        "把这份 PDF 总结一下",
        "解析这份 Word 文档",
        "把数据导出成 Excel",
        "read this file and summarize",
      ],
      negativeExamples: [
        "画一张猫的图",
        "给我打个电话",
        "把灯关了",
      ],
    },
  },
  {
    exact: "file.read_text",
    metadata: {
      aliases: [
        "read file", "read text", "load file", "open file", "view file",
        "读文件", "读取文件", "看文件", "打开文件", "读一下",
      ],
      examples: [
        "读一下这个 json 文件",
        "把这个 md 文件的内容给我",
        "read this csv file",
      ],
      negativeExamples: [
        "把这段话存成文件",
        "导出成 Excel",
      ],
    },
  },
  {
    exact: "file.write_text",
    metadata: {
      aliases: [
        "write file", "save file", "save text", "create file", "store file",
        "写文件", "保存文件", "存成文件", "保存为", "保存文本",
      ],
      examples: [
        "把这段总结保存成 md 文件",
        "存成 notes.txt",
        "save this as a json file",
      ],
      negativeExamples: [
        "读一下这个文件",
        "解析这份 PDF",
      ],
    },
  },
  {
    exact: "file.parse_pdf",
    metadata: {
      aliases: [
        "pdf", "parse pdf", "extract pdf", "pdf to text", "read pdf",
        "解析 PDF", "读 PDF", "提取 PDF 文本", "PDF 总结",
      ],
      examples: [
        "解析这份 PDF",
        "把这份 PDF 总结成要点",
        "提取 PDF 的文本",
        "extract text from this pdf",
      ],
      negativeExamples: [
        "解析这份 Word 文档",
        "导出成 Excel",
      ],
    },
  },
  {
    exact: "file.parse_office",
    metadata: {
      aliases: [
        "word", "docx", "excel", "xlsx", "spreadsheet", "pptx", "powerpoint",
        "parse word", "parse excel", "parse office",
        "解析 Word", "解析 Excel", "解析 PPT", "读 Word 文档", "读 Excel 表格",
        "电子表格", "表格", "演示文稿",
      ],
      examples: [
        "解析这份 Word 文档",
        "把这个 Excel 表读出来",
        "提取 docx 内容",
        "parse this xlsx file",
      ],
      negativeExamples: [
        "解析这份 PDF",
        "把这段文本导出成 md",
      ],
    },
  },
  {
    exact: "file.export_format",
    metadata: {
      aliases: [
        "export", "export to", "convert to", "save as", "download as",
        "导出", "导出为", "转换成", "保存为", "下载为",
        "导出 excel", "导出 json", "导出 csv", "存成 excel", "存成 json",
      ],
      examples: [
        "把数据导出成 Excel",
        "导出为 json 文件",
        "存成 csv 给我下载",
        "export this as a markdown file",
      ],
      negativeExamples: [
        "读一下这个文件",
        "解析这份 PDF",
      ],
    },
  },
];
