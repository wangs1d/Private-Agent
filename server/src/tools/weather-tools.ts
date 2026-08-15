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
      const geo = await resolveUserGeo({
        clientIp: context.clientIp,
        clientLocation: context.clientLocation,
      });
      let liveLat = geo?.latitude;
      let liveLon = geo?.longitude;
      let liveCity = geo?.city ?? "";
      if (liveLat == null || liveLon == null) {
        // 未携带位置：按需向客户端请求实时 GPS（仅 Agent 调用天气工具时产生一次 GPS 开销）。
        const live = await context.requestLocation?.("weather.get_local");
        if (live) {
          liveLat = live.latitude;
          liveLon = live.longitude;
          liveCity = live.city ?? "";
          if (!label) {
            label = [live.district, live.city, live.region, live.country]
              .filter(Boolean)
              .join(" · ");
          }
        }
      }
      if (liveLat != null && liveLon != null) {
        lat = liveLat;
        lon = liveLon;
        label = label || [geo?.district, geo?.city, geo?.region, geo?.country].filter(Boolean).join(" · ");
      } else if (liveCity) {
        city = liveCity;
        if (!label) label = [geo?.city, geo?.region, geo?.country].filter(Boolean).join(" · ");
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
        error: "需要有效的 latitude 与 longitude，或提供可解析的 city",
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
