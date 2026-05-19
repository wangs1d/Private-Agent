/**
 * Skill 沙箱执行环境 - 提供安全的执行隔离
 */

import type {
  SkillDefinition,
  SkillExecutionContext,
  SkillExecutionResult,
  SkillPermission,
  SkillLogger,
} from "./types.js";

export class SkillSandbox {
  private readonly maxExecutionTime: number;

  constructor(maxExecutionTime: number = 5000) {
    this.maxExecutionTime = maxExecutionTime;
  }

  /**
   * 在沙箱中执行 Skill
   */
  async execute(
    skill: SkillDefinition,
    input: Record<string, unknown>,
    context: Omit<SkillExecutionContext, "logger" | "storage"> & {
      grantedPermissions: Set<SkillPermission>;
    }
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    const logger = this.createLogger(skill.metadata.name);
    const storage = new Map<string, unknown>();

    // 构建执行上下文
    const execContext: SkillExecutionContext = {
      ...context,
      permissions: context.grantedPermissions,
      storage,
      logger,
    };

    try {
      // 设置超时保护
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Skill 执行超时 (${this.maxExecutionTime}ms)`));
        }, this.maxExecutionTime);
      });

      // 执行 Skill 处理器
      const result = await Promise.race([
        skill.handler(input, execContext),
        timeoutPromise,
      ]);

      const executionTime = Date.now() - startTime;

      // 验证返回结果
      if (typeof result !== "object" || result === null) {
        return {
          ok: false,
          error: {
            code: "INVALID_RESULT",
            message: "Skill 必须返回一个对象",
          },
          executionTime,
        };
      }

      return {
        ok: true,
        result: result as Record<string, unknown>,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "未知错误";

      logger.error("Skill 执行失败", { error: errorMessage });

      return {
        ok: false,
        error: {
          code: error instanceof Error ? error.constructor.name : "UNKNOWN_ERROR",
          message: errorMessage,
          details: error,
        },
        executionTime,
      };
    }
  }

  /**
   * 检查权限是否满足
   */
  static checkPermissions(
    required: SkillPermission[],
    granted: Set<SkillPermission>
  ): { allowed: boolean; denied: SkillPermission[] } {
    const denied = required.filter((perm) => !granted.has(perm));
    return {
      allowed: denied.length === 0,
      denied,
    };
  }

  /**
   * 创建隔离的日志记录器
   */
  private createLogger(skillName: string): SkillLogger {
    const prefix = `[Skill:${skillName}]`;

    return {
      info: (message, data) => {
        console.log(`${prefix} [INFO] ${message}`, data || "");
      },
      warn: (message, data) => {
        console.warn(`${prefix} [WARN] ${message}`, data || "");
      },
      error: (message, data) => {
        console.error(`${prefix} [ERROR] ${message}`, data || "");
      },
      debug: (message, data) => {
        if (process.env.DEBUG) {
          console.debug(`${prefix} [DEBUG] ${message}`, data || "");
        }
      },
    };
  }

  /**
   * 资源限制检查（防止恶意 Skill）
   */
  static validateResourceLimits(skill: SkillDefinition): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // 检查是否有危险的全局访问
    const handlerStr = skill.handler.toString();
    const dangerousPatterns = [
      /process\./,           // 访问 process 对象
      /require\s*\(/,        // 动态 require
      /eval\s*\(/,           // eval 执行
      /Function\s*\(/,       // Function 构造器
      /__dirname/,           // 访问目录名
      /__filename/,          // 访问文件名
    ];

    dangerousPatterns.forEach((pattern) => {
      if (pattern.test(handlerStr)) {
        issues.push(`检测到潜在危险操作: ${pattern.source}`);
      }
    });

    return {
      valid: issues.length === 0,
      issues,
    };
  }
}
