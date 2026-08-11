/**
 * better-sqlite3 的最小 ambient 类型声明。
 *
 * better-sqlite3 v12 自身不附带 .d.ts，且项目未引入 @types/better-sqlite3。
 * 此声明覆盖 tool-registry 分级存储（store.ts）实际用到的同步 API 表面，
 * 与官方 @types/better-sqlite3 形状保持兼容（安装后会自动合并）。
 */

declare module "better-sqlite3" {
  export type SqliteValue = null | number | string | Buffer;

  export interface StatementBinding {
    [key: string]: SqliteValue;
  }

  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface Statement<T = unknown> {
    run(...params: SqliteValue[]): RunResult;
    run(params: StatementBinding): RunResult;
    get<T2 = T>(...params: SqliteValue[]): T2 | undefined;
    get<T2 = T>(params: StatementBinding): T2 | undefined;
    all<T2 = T>(...params: SqliteValue[]): T2[];
    all<T2 = T>(params: StatementBinding): T2[];
    iterate<T2 = T>(...params: SqliteValue[]): Iterable<T2>;
    iterate<T2 = T>(params: StatementBinding): Iterable<T2>;
    pluck<T2 = T>(toggle?: boolean): this;
    expand<T2 = T>(toggle?: boolean): this;
    raw<T2 = T>(toggle?: boolean): this;
    bind(...params: SqliteValue[]): this;
    bind(params: StatementBinding): this;
  }

  export interface Database {
    prepare<Param = StatementBinding, Result = unknown>(
      sql: string,
    ): Statement<Result>;
    exec(sql: string): this;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    close(): void;
    transaction<T>(fn: () => T): () => T;
    transaction<T, A extends unknown[]>(
      fn: (...args: A) => T,
    ): (...args: A) => T;
  }

  export interface DatabaseOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
    verbose?: (message?: unknown) => void;
  }

  /** 构造器对象：`new Database(filename, options?)` 打开 / 创建一个 SQLite 文件。 */
  export interface DatabaseConstructor {
    new (filename: string, options?: DatabaseOptions): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
