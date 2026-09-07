/**
 * 到站管家（接站 / 接机 / 到站打车）公共出口。
 */

export type {
  TripStage,
  TripStatusSnapshot,
  TripStatusQuery,
  TripStatusProvider,
  TripStatusResult,
  PickupSendResult,
} from "./types.js";
export { TRIP_STAGE_LABELS, parseLooseTime } from "./types.js";
export { VariflightFlightProvider } from "./providers/variflight-flight-provider.js";
export { JuheTrainProvider } from "./providers/juhe-train-provider.js";
export { ManualScheduleProvider } from "./providers/manual-schedule-provider.js";
export { PickupSender } from "./pickup-sender.js";
export {
  ArrivalMonitorService,
  composePickupMessage,
  type ArrivalMonitorDeps,
} from "./arrival-monitor-service.js";
