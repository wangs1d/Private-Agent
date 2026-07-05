/**
 * 终端互连平台 device-bus 模块入口
 *
 * 阶段性建设：
 *  - Phase 1（当前）：设备模型 + 注册表 + 适配器接口（本文件导出）
 *  - Phase 2：协议扩展（protocol.ts 追加 device.* 事件族）+ device-rpc 双向调用链路
 *  - Phase 3：phone / desktop / home 三类适配器包装现有桥接
 *  - Phase 4：camera / glasses / tablet 新增适配器
 *  - Phase 5：device-pairing 配对与发现
 *  - Phase 6：device.* LLM 工具暴露
 *  - Phase 7：Flutter「我的设备」页
 */
export type {
  CapabilityDeclaration,
  CapabilityId,
  DeviceConnectionKind,
  DeviceDescriptor,
  DeviceInvokeResult,
  DeviceKind,
  DeviceStatus,
  DeviceStreamChunk,
} from "./device-model.js";

export type {
  AdapterStaticInfo,
  DeviceAdapter,
  DeviceAdapterInit,
  DeviceAdapterFactory,
  DeviceConnection,
} from "./device-adapter.js";

export {
  DeviceRegistry,
  type DeviceChangeEvent,
  type DeviceChangeListener,
} from "./device-registry.js";

export {
  WsDeviceRpcBridge,
  type WsDeviceRpcBridgeOptions,
} from "./device-rpc.js";

// 适配器工厂（Phase 3 + Phase 4）
export { createHomeAdapterFactory } from "./adapters/home-adapter.js";
export { createPhoneAdapterFactory } from "./adapters/phone-adapter.js";
export { createDesktopAdapterFactory } from "./adapters/desktop-adapter.js";
export { createTabletAdapterFactory } from "./adapters/tablet-adapter.js";
export { createGlassesAdapterFactory } from "./adapters/glasses-adapter.js";
export { createCameraAdapterFactory } from "./adapters/camera-adapter.js";
export { createWsRemoteAdapterFactory } from "./adapters/ws-remote-adapter.js";
