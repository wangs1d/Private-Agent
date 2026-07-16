// Agent Brain Center — 模块出口
export * from "./types.js";
export { BrainCenter } from "./brain-center.js";
export { CapabilityCortex } from "./capability-cortex.js";
export { AwarenessCortex } from "./awareness-cortex.js";
export { ProactionCortex, type EndToEndDecisionMaker, type EndToEndDecisionContext, type MemoryCortexLike } from "./proaction-cortex.js";
export { EvolutionCortex } from "./evolution-cortex.js";
export { SensoryCortex } from "./sensory-cortex.js";
export { MemoryCortex } from "./memory-cortex.js";
export { SynapseBus } from "./synapse-bus.js";
export { LimbicCortex } from "./limbic-cortex.js";
export { PlannerCortex } from "./planner-cortex.js";
// subcortical 分区（脑干/小脑）：自主节律 + 时序协调
export { BrainStem } from "./brain-stem.js";
export { Cerebellum } from "./cerebellum.js";
