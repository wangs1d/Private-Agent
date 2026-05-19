/**
 * Skill 管理器 - 管理 Skill 的生命周期、权限和配置
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, extname } from "path";
import type {
  SkillDefinition,
  SkillManifest,
  SkillConfig,
  SkillLoadOptions,
  SkillPermission,
} from "./types.js";
import { SkillValidator } from "./skill-validator.js";
import { SkillSandbox } from "./skill-sandbox.js";

export class SkillManager {
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly configs = new Map<string, SkillConfig>();
  private readonly grantedPermissions = new Map<string, Set<SkillPermission>>();
  private readonly sandbox: SkillSandbox;

  constructor(sandbox?: SkillSandbox) {
    this.sandbox = sandbox || new SkillSandbox();
  }

  /**
   * 注册 Skill（代码方式）
   */
  register(skill: SkillDefinition, options?: SkillLoadOptions): void {
    // 验证 Skill 定义
    const errors = SkillValidator.validate(skill);
    if (errors.length > 0) {
      throw new Error(
        `Skill 验证失败: ${errors.map((e) => `${e.field}: ${e.message}`).join(", ")}`
      );
    }

    // 检查资源限制
    const resourceCheck = SkillSandbox.validateResourceLimits(skill);
    if (!resourceCheck.valid) {
      console.warn(`Skill '${skill.metadata.name}' 资源检查警告:`, resourceCheck.issues);
    }

    const skillName = skill.metadata.name;

    // 设置默认配置
    if (!this.configs.has(skillName)) {
      this.configs.set(skillName, {
        enabled: options?.autoEnable ?? true,
        permissions: skill.metadata.permissions,
      });
    }

    // 设置默认权限
    if (!this.grantedPermissions.has(skillName)) {
      const config = this.configs.get(skillName)!;
      const permissions = new Set(config.permissions || skill.metadata.permissions);
      this.grantedPermissions.set(skillName, permissions);
    }

    // 存储 Skill
    this.skills.set(skillName, skill);

    console.log(`✅ Skill 已注册: ${skillName} v${skill.metadata.version}`);
  }

  /**
   * 从文件加载 Skill（JSON 元数据 + JS 模块）
   */
  async loadFromFile(skillPath: string, options?: SkillLoadOptions): Promise<void> {
    if (!existsSync(skillPath)) {
      throw new Error(`Skill 文件不存在: ${skillPath}`);
    }

    const stat = require("fs").statSync(skillPath);
    
    if (stat.isDirectory()) {
      // 加载目录中的所有 Skill
      await this.loadFromDirectory(skillPath, options);
      return;
    }

    const ext = extname(skillPath);

    if (ext === ".json") {
      // 仅加载元数据文件
      await this.loadMetadataFile(skillPath, options);
    } else if (ext === ".js" || ext === ".ts") {
      // 加载完整的 Skill 模块
      await this.loadModuleFile(skillPath, options);
    } else {
      throw new Error(`不支持的文件类型: ${ext}`);
    }
  }

  /**
   * 从目录批量加载 Skill
   */
  private async loadFromDirectory(dirPath: string, options?: SkillLoadOptions): Promise<void> {
    const files = readdirSync(dirPath);
    
    for (const file of files) {
      const fullPath = join(dirPath, file);
      try {
        await this.loadFromFile(fullPath, options);
      } catch (error) {
        console.error(`加载 Skill 失败 (${file}):`, error);
      }
    }
  }

  /**
   * 加载元数据文件
   */
  private async loadMetadataFile(filePath: string, options?: SkillLoadOptions): Promise<void> {
    const content = readFileSync(filePath, "utf-8");
    const metadata = JSON.parse(content);

    // 这里需要找到对应的处理器文件
    const dir = require("path").dirname(filePath);
    const baseName = require("path").basename(filePath, ".json");
    const handlerPath = join(dir, `${baseName}.handler.js`);

    if (existsSync(handlerPath)) {
      const module = await import(handlerPath);
      const skill: SkillDefinition = {
        metadata,
        handler: module.default || module.handler,
      };
      this.register(skill, options);
    } else {
      console.warn(`未找到处理器文件: ${handlerPath}`);
    }
  }

  /**
   * 加载模块文件
   */
  private async loadModuleFile(filePath: string, options?: SkillLoadOptions): Promise<void> {
    const module = await import(filePath);
    
    // 支持默认导出或命名导出
    const skill: SkillDefinition = module.default || module.skill;
    
    if (!skill || !skill.metadata || !skill.handler) {
      throw new Error(`无效的 Skill 模块格式: ${filePath}`);
    }

    this.register(skill, options);
  }

  /**
   * 执行 Skill
   */
  async execute(
    skillName: string,
    input: Record<string, unknown>,
    context: { sessionId: string }
  ): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: any }> {
    const skill = this.skills.get(skillName);
    
    if (!skill) {
      return {
        ok: false,
        error: { code: "SKILL_NOT_FOUND", message: `Skill 不存在: ${skillName}` },
      };
    }

    // 检查是否启用
    const config = this.configs.get(skillName);
    if (config?.enabled === false) {
      return {
        ok: false,
        error: { code: "SKILL_DISABLED", message: `Skill 已禁用: ${skillName}` },
      };
    }

    // 验证输入参数
    const validationErrors = SkillValidator.validateInput(input, skill.metadata.parameters);
    if (validationErrors.length > 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "输入参数验证失败",
          details: validationErrors,
        },
      };
    }

    // 检查权限
    const grantedPerms = this.grantedPermissions.get(skillName) || new Set();
    const permissionCheck = SkillSandbox.checkPermissions(
      skill.metadata.permissions,
      grantedPerms
    );

    if (!permissionCheck.allowed) {
      return {
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          message: `权限不足，需要: ${permissionCheck.denied.join(", ")}`,
          denied: permissionCheck.denied,
        },
      };
    }

    // 在沙箱中执行
    const result = await this.sandbox.execute(skill, input, {
      sessionId: context.sessionId,
      permissions: grantedPerms,
      grantedPermissions: grantedPerms,
    });

    return result;
  }

  /**
   * 列出所有可用的 Skill
   */
  list(enabledOnly: boolean = false): SkillManifest[] {
    const manifests: SkillManifest[] = [];

    this.skills.forEach((skill, name) => {
      const config = this.configs.get(name);
      const isTrusted = this.grantedPermissions.has(name);

      if (enabledOnly && config?.enabled === false) {
        return;
      }

      manifests.push({
        ...skill.metadata,
        enabled: config?.enabled ?? true,
        trusted: isTrusted,
      });
    });

    return manifests.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /**
   * 获取 Skill 详情
   */
  get(skillName: string): SkillManifest | null {
    const skill = this.skills.get(skillName);
    if (!skill) return null;

    const config = this.configs.get(skillName);
    const isTrusted = this.grantedPermissions.has(skillName);

    return {
      ...skill.metadata,
      enabled: config?.enabled ?? true,
      trusted: isTrusted,
    };
  }

  /**
   * 启用/禁用 Skill
   */
  setEnabled(skillName: string, enabled: boolean): void {
    if (!this.skills.has(skillName)) {
      throw new Error(`Skill 不存在: ${skillName}`);
    }

    const config = this.configs.get(skillName) || {};
    config.enabled = enabled;
    this.configs.set(skillName, config);

    console.log(`${enabled ? "✅ 启用" : "⏸️  禁用"} Skill: ${skillName}`);
  }

  /**
   * 授予权限
   */
  grantPermissions(skillName: string, permissions: SkillPermission[]): void {
    if (!this.skills.has(skillName)) {
      throw new Error(`Skill 不存在: ${skillName}`);
    }

    const current = this.grantedPermissions.get(skillName) || new Set();
    permissions.forEach((p) => current.add(p));
    this.grantedPermissions.set(skillName, current);

    console.log(`🔑 授予权限给 ${skillName}: ${permissions.join(", ")}`);
  }

  /**
   * 撤销权限
   */
  revokePermissions(skillName: string, permissions: SkillPermission[]): void {
    if (!this.skills.has(skillName)) {
      throw new Error(`Skill 不存在: ${skillName}`);
    }

    const current = this.grantedPermissions.get(skillName);
    if (current) {
      permissions.forEach((p) => current.delete(p));
      this.grantedPermissions.set(skillName, current);
      console.log(`🔒 撤销权限从 ${skillName}: ${permissions.join(", ")}`);
    }
  }

  /**
   * 卸载 Skill
   */
  uninstall(skillName: string): void {
    if (!this.skills.has(skillName)) {
      throw new Error(`Skill 不存在: ${skillName}`);
    }

    this.skills.delete(skillName);
    this.configs.delete(skillName);
    this.grantedPermissions.delete(skillName);

    console.log(`🗑️  已卸载 Skill: ${skillName}`);
  }

  /**
   * 更新 Skill 配置
   */
  updateConfig(skillName: string, config: Partial<SkillConfig>): void {
    if (!this.skills.has(skillName)) {
      throw new Error(`Skill 不存在: ${skillName}`);
    }

    const current = this.configs.get(skillName) || {};
    this.configs.set(skillName, { ...current, ...config });

    console.log(`⚙️  更新配置: ${skillName}`, config);
  }

  /**
   * 获取 Skill 统计信息
   */
  getStats(): {
    total: number;
    enabled: number;
    disabled: number;
    trusted: number;
  } {
    let enabled = 0;
    let disabled = 0;
    let trusted = 0;

    this.skills.forEach((_, name) => {
      const config = this.configs.get(name);
      if (config?.enabled === false) {
        disabled++;
      } else {
        enabled++;
      }

      if (this.grantedPermissions.has(name)) {
        trusted++;
      }
    });

    return {
      total: this.skills.size,
      enabled,
      disabled,
      trusted,
    };
  }
}
