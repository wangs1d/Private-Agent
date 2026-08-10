/**
 * Adaptive Hierarchical Tool Intelligence System —— Phase-1 资源注册中心入口。
 *
 * 仅做导出聚合，不含运行时逻辑。
 * 实例化时序：ToolRegistryStore.initialize() → new RegistryService(store) → 挂载路由。
 */

export * from "./models.js";
export { ToolRegistryStore, type ToolRegistryStoreOptions } from "./store.js";
export {
  RegistryService,
  type RegisterResult,
  type RegisterInput,
  type PublishVersionInput,
  type RollbackInput,
  getCurrentToolRegistryEnvironment,
  RegistryErrorCode,
  type RegistryErrorCode as RegistryErrorCodeType,
} from "./registry-service.js";
