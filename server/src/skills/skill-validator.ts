/**
 * Skill 验证器 - 验证 Skill 定义的合法性
 */

import type {
  SkillDefinition,
  SkillMetadata,
  SkillParameter,
  SkillValidationError,
} from "./types.js";

export class SkillValidator {
  /**
   * 验证 Skill 元数据
   */
  static validateMetadata(metadata: SkillMetadata): SkillValidationError[] {
    const errors: SkillValidationError[] = [];

    // 验证名称格式（必须是 namespace.action 格式）
    if (!metadata.name || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*$/.test(metadata.name)) {
      errors.push({
        field: "name",
        message: "Skill 名称必须符合 'namespace.action' 格式，如 'budget.calculate'",
        code: "INVALID_NAME_FORMAT",
      });
    }

    // 验证版本号（语义化版本）
    if (!metadata.version || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
      errors.push({
        field: "version",
        message: "版本号必须符合语义化版本格式，如 '1.0.0'",
        code: "INVALID_VERSION",
      });
    }

    // 验证显示名称
    if (!metadata.displayName || metadata.displayName.length < 2) {
      errors.push({
        field: "displayName",
        message: "显示名称至少需要 2 个字符",
        code: "INVALID_DISPLAY_NAME",
      });
    }

    // 验证描述
    if (!metadata.description || metadata.description.length < 10) {
      errors.push({
        field: "description",
        message: "描述至少需要 10 个字符",
        code: "INVALID_DESCRIPTION",
      });
    }

    // 验证参数列表
    if (!Array.isArray(metadata.parameters)) {
      errors.push({
        field: "parameters",
        message: "参数列表必须是数组",
        code: "INVALID_PARAMETERS",
      });
    } else {
      metadata.parameters.forEach((param, index) => {
        const paramErrors = this.validateParameter(param);
        paramErrors.forEach((err) => {
          err.field = `parameters[${index}].${err.field}`;
          errors.push(err);
        });
      });
    }

    // 验证权限列表
    if (!Array.isArray(metadata.permissions)) {
      errors.push({
        field: "permissions",
        message: "权限列表必须是数组",
        code: "INVALID_PERMISSIONS",
      });
    }

    // 验证超时时间
    if (metadata.timeoutMs !== undefined && (metadata.timeoutMs < 100 || metadata.timeoutMs > 30000)) {
      errors.push({
        field: "timeoutMs",
        message: "超时时间必须在 100ms 到 30000ms 之间",
        code: "INVALID_TIMEOUT",
      });
    }

    return errors;
  }

  /**
   * 验证单个参数
   */
  private static validateParameter(param: SkillParameter): SkillValidationError[] {
    const errors: SkillValidationError[] = [];

    if (!param.name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(param.name)) {
      errors.push({
        field: "name",
        message: "参数名必须是有效的标识符",
        code: "INVALID_PARAM_NAME",
      });
    }

    const validTypes = ["string", "number", "boolean", "object", "array"];
    if (!validTypes.includes(param.type)) {
      errors.push({
        field: "type",
        message: `参数类型必须是 ${validTypes.join(", ")} 之一`,
        code: "INVALID_PARAM_TYPE",
      });
    }

    return errors;
  }

  /**
   * 验证输入数据是否符合参数定义
   */
  static validateInput(
    input: Record<string, unknown>,
    parameters: SkillParameter[]
  ): SkillValidationError[] {
    const errors: SkillValidationError[] = [];

    // 检查必填参数
    parameters.forEach((param) => {
      if (param.required && !(param.name in input)) {
        errors.push({
          field: param.name,
          message: `缺少必填参数: ${param.name}`,
          code: "MISSING_REQUIRED_PARAM",
        });
      }
    });

    // 验证参数类型
    Object.entries(input).forEach(([key, value]) => {
      const paramDef = parameters.find((p) => p.name === key);
      if (!paramDef) {
        errors.push({
          field: key,
          message: `未知参数: ${key}`,
          code: "UNKNOWN_PARAM",
        });
        return;
      }

      const typeError = this.validateParamType(key, value, paramDef);
      if (typeError) {
        errors.push(typeError);
      }

      // 验证枚举值
      if (paramDef.enum && !paramDef.enum.includes(value)) {
        errors.push({
          field: key,
          message: `参数值必须是以下之一: ${paramDef.enum.join(", ")}`,
          code: "INVALID_ENUM_VALUE",
        });
      }
    });

    return errors;
  }

  /**
   * 验证参数类型
   */
  private static validateParamType(
    paramName: string,
    value: unknown,
    paramDef: SkillParameter
  ): SkillValidationError | null {
    const actualType = typeof value;

    switch (paramDef.type) {
      case "string":
        if (actualType !== "string") {
          return {
            field: paramName,
            message: `参数 '${paramName}' 必须是字符串类型`,
            code: "INVALID_PARAM_TYPE",
          };
        }
        break;
      case "number":
        if (actualType !== "number" || isNaN(value as number)) {
          return {
            field: paramName,
            message: `参数 '${paramName}' 必须是有效数字`,
            code: "INVALID_PARAM_TYPE",
          };
        }
        break;
      case "boolean":
        if (actualType !== "boolean") {
          return {
            field: paramName,
            message: `参数 '${paramName}' 必须是布尔值`,
            code: "INVALID_PARAM_TYPE",
          };
        }
        break;
      case "object":
        if (actualType !== "object" || value === null || Array.isArray(value)) {
          return {
            field: paramName,
            message: `参数 '${paramName}' 必须是对象类型`,
            code: "INVALID_PARAM_TYPE",
          };
        }
        break;
      case "array":
        if (!Array.isArray(value)) {
          return {
            field: paramName,
            message: `参数 '${paramName}' 必须是数组类型`,
            code: "INVALID_PARAM_TYPE",
          };
        }
        break;
    }

    return null;
  }

  /**
   * 完整验证 Skill 定义
   */
  static validate(skill: SkillDefinition): SkillValidationError[] {
    const metadataErrors = this.validateMetadata(skill.metadata);
    
    if (!skill.handler || typeof skill.handler !== "function") {
      metadataErrors.push({
        field: "handler",
        message: "必须提供有效的处理函数",
        code: "INVALID_HANDLER",
      });
    }

    return metadataErrors;
  }
}
