/**
 * 预订 Provider 注册表。
 *
 * 按 BOOKING_MODE 组装默认 Provider 集：
 *   - mock（默认）：三个模拟 Provider（ride / home_service / restaurant），
 *     全链路可跑通，所有结果 simulated=true，不会真实下单
 *   - live：高德打车（需 key）等真实 Provider；模拟 Provider 不注册，
 *     避免 live 模式下出现假下单结果
 */

import type { BookingProvider } from "../booking-provider.js";
import type { BookingConfig } from "../booking-config.js";
import { SimulatedRideProvider } from "./simulated-ride-provider.js";
import { SimulatedHomeServiceProvider, SimulatedRestaurantProvider } from "./simulated-local-providers.js";
import { AmapRideProvider } from "./amap-ride-provider.js";
import { TravelTicketProvider } from "./travel-ticket-provider.js";

export function buildDefaultBookingProviders(config: BookingConfig): BookingProvider[] {
  if (config.mode === "mock") {
    return [
      new SimulatedRideProvider(),
      new SimulatedHomeServiceProvider(),
      new SimulatedRestaurantProvider(),
      // travel 域在 mock 模式也注册：本 provider 的 book 只建「待支付」订单，
      // 真实扣款必须经用户本人支付宝钱包授权（booking.travel-pay），无静默扣款风险
      new TravelTicketProvider(),
    ];
  }
  const providers: BookingProvider[] = [
    new TravelTicketProvider(),
  ];
  if (config.rideAmapWebKey) {
    providers.push(new AmapRideProvider(config));
  }
  return providers;
}

export { TravelTicketProvider } from "./travel-ticket-provider.js";
