/**
 * 第三方文件解析依赖的最小 ambient 类型声明。
 *
 * 这些包（pdf-parse / mammoth / xlsx）由 file-doc 能力模块使用。
 * 主线程在 package.json 加入依赖后：
 *   - mammoth / xlsx 自带类型，会与本声明合并（不冲突）；
 *   - pdf-parse 无官方类型，本声明作为唯一类型来源。
 * 在未安装时本声明也保证 tsc 可过（避免 "Cannot find module"）。
 */

declare module "pdf-parse" {
  export interface PdfParseResult {
    text: string;
    numpages: number;
    numrender?: number;
    info?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
  /** 默认导出：把 PDF Buffer 解析为纯文本 + 元信息。 */
  function pdfParse(
    buffer: Buffer,
    options?: Record<string, unknown>,
  ): Promise<PdfParseResult>;
  export default pdfParse;
}

declare module "mammoth" {
  export interface ConvertResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  export interface ConvertInput {
    buffer?: Buffer;
    arrayBuffer?: ArrayBuffer;
    path?: string;
  }
  /** docx → HTML。 */
  export function convertToHtml(input: ConvertInput): Promise<ConvertResult>;
  /** docx → 纯文本。 */
  export function extractRawText(input: ConvertInput): Promise<ConvertResult>;
}

declare module "xlsx" {
  export interface WorkSheet {
    [cell: string]: unknown;
    "!ref"?: string;
  }
  export interface WorkBook {
    SheetNames: string[];
    Sheets: Record<string, WorkSheet>;
  }
  export function read(data: Buffer | ArrayBuffer | string, opts?: {
    type?: "buffer" | "array" | "string" | "binary";
    cellDates?: boolean;
    [k: string]: unknown;
  }): WorkBook;
  /** 序列化 workbook 为 Buffer / string 等（依据 type）。 */
  export function write(wb: WorkBook, opts?: {
    type?: "buffer" | "array" | "string" | "binary" | "file" | "base64";
    bookType?: string;
    [k: string]: unknown;
  }): unknown;
  export function sheet_to_json<T = Record<string, unknown>>(
    sheet: WorkSheet,
    opts?: Record<string, unknown>,
  ): T[];
  export const utils: {
    book_new(): WorkBook;
    book_append_sheet(wb: WorkBook, ws: WorkSheet, name?: string): void;
    json_to_sheet<T = unknown>(data: T[], opts?: Record<string, unknown>): WorkSheet;
    aoa_to_sheet<T = unknown>(data: T[][], opts?: Record<string, unknown>): WorkSheet;
    book_write(wb: WorkBook, opts?: {
      type?: "buffer" | "binary" | "string" | "array";
      bookType?: string;
    }): unknown;
  };
}
