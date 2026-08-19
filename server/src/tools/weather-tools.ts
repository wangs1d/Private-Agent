import type { ToolRegistry } from "./tool-registry.js";
import { geocodeCity, WeatherService } from "../services/weather-service.js";
import { resolveUserGeo } from "../services/user-location-service.js";

export function registerWeatherTools(registry: ToolRegistry, weather: WeatherService): void {
  registry.register("weather.get_local", async (input, context) => {
    const timezone = String(input.timezone ?? "Asia/Shanghai").trim() || "Asia/Shanghai";
    let city = input.city != null ? String(input.city).trim() : "";
    let lat = input.latitude != null ? Number(input.latitude) : NaN;
    let lon = input.longitude != null ? Number(input.longitude) : NaN;
    let label = input.locationLabel != null ? String(input.locationLabel).trim() : "";

    if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && !city) {
      // 用户未明确城市名：天气必须取「用户真实所在地」，禁止用训练数据臆测城市。
      // 1) 优先按需实时位置：复用 LocationCoordinator 新鲜缓存（天气面板上报的定位），
      //    否则向客户端下发 agent.location_request 请求实时 GPS
      //    （仅 Agent 调用天气工具时产生一次 GPS 开销，不随每条消息携带）。
      // 2) 兜底消息自带 GPS（经逆地理得到干净 label + 时区）。
      const live = await context.requestLocation?.("weather.get_local");
      if (live && Number.isFinite(live.latitude) && Number.isFinite(live.longitude)) {
        lat = live.latitude;
        lon = live.longitude;
        if (!label) {
          label = [live.district, live.city, live.region, live.country]
            .filter(Boolean)
            .join(" · ");
        }
      }

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        const geo = await resolveUserGeo({
          clientIp: context.clientIp,
          clientLocation: context.clientLocation,
        });
        if (geo?.latitude != null && geo?.longitude != null) {
          lat = geo.latitude;
          lon = geo.longitude;
          if (!label) label = [geo.district, geo.city, geo.region, geo.country].filter(Boolean).join(" · ");
        } else if (geo?.city) {
          city = geo.city;
          if (!label) label = [geo.city, geo.region, geo.country].filter(Boolean).join(" · ");
        }
      }
    }

    if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && city) {
      const g = await geocodeCity(city);
      if (!g) {
        return { ok: false, error: `无法解析城市：${city}` };
      }
      lat = g.latitude;
      lon = g.longitude;
      label = [g.name, g.admin1, g.country].filter(Boolean).join(" · ");
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return {
        ok: false,
        error:
          "没有拿到真实定位，也没有可解析的城市名。必须请用户提供城市或开启定位；禁止猜测用户所在城市或编造天气。",
      };
    }

    const brief = await weather.getBrief(lat, lon, timezone, label || undefined);
    return {
      ok: true,
      summary: brief.summaryLine,
      clothingAdvice: brief.clothingAdvice,
      currentTempC: brief.currentTempC,
      apparentTempC: brief.apparentTempC,
      todayRangeC: `${brief.todayMinC.toFixed(0)}–${brief.todayMaxC.toFixed(0)}`,
      weatherText: brief.weatherText,
      humidityPct: brief.humidityPct,
      windKmh: brief.windKmh,
      peakRainPct: brief.peakRainPct,
      locationLabel: brief.locationLabel,
    };
  });
}
