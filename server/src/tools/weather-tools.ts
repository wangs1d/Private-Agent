import type { ToolRegistry } from "./tool-registry.js";
import { geocodeCity, WeatherService } from "../services/weather-service.js";
import { resolveUserGeo } from "../services/user-location-service.js";
import { reverseGeocodeCoordinates } from "../services/reverse-geocode-service.js";

/**
 * label 相邻去重（2026-10-08）：逆地理返回的 district/city/region 经常重复
 * （如「東城區 · 北京市 · 北京市 · 中华人民共和国」），观感差。
 */
function dedupLabel(parts: Array<string | undefined | null>): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter((p, i, arr) => p && p !== arr[i - 1])
    .join(" · ");
}

export function registerWeatherTools(registry: ToolRegistry, weather: WeatherService): void {
  registry.register("weather.get_local", async (input, context) => {
    let timezone = String(input.timezone ?? "Asia/Shanghai").trim() || "Asia/Shanghai";
    let city = input.city != null ? String(input.city).trim() : "";
    let lat = input.latitude != null ? Number(input.latitude) : NaN;
    let lon = input.longitude != null ? Number(input.longitude) : NaN;
    let label = input.locationLabel != null ? String(input.locationLabel).trim() : "";
    // 位置来源可观测（2026-10-08）：定位答错的排查日志——真机测试时看这行
    // 就知道 agent 为什么答这个城市（实时GPS/兜底解析/用户显式城市）。
    let locSource = city ? "explicit-city" : "unresolved";

    if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && !city) {
      // 用户未明确城市名：天气必须取「用户真实所在地」，禁止用训练数据臆测城市。
      // 1) 优先按需实时位置：复用 LocationCoordinator 新鲜缓存（天气面板上报的定位），
      //    否则向客户端下发 agent.location_request 请求实时 GPS
      //    （仅 Agent 调用天气工具时产生一次 GPS 开销，不随每条消息携带）。
      // 2) 兜底消息自带 GPS（经逆地理得到干净 label + 时区）。
      const live = await context.requestLocation?.("weather.get_local");
      if (live && Number.isFinite(live.latitude) && Number.isFinite(live.longitude)) {
        locSource = "live-gps";
        lat = live.latitude;
        lon = live.longitude;
        if (!label) {
          label = dedupLabel([live.district, live.city, live.region, live.country]);
        }
        // 客户端按需回包是纯坐标（省一次手机↔服务端逆地理往返，GPS 秒回）：
        // label 缺失时在服务端逆地理补齐城市名，否则卡片标题会退化成「31.23, 121.47」。
        if (!label) {
          const rev = await reverseGeocodeCoordinates(lat, lon);
          if (rev) {
            label = rev.label;
            if (rev.timezone) timezone = rev.timezone;
          }
        }
      }

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        const geo = await resolveUserGeo({
          clientIp: context.clientIp,
          clientLocation: context.clientLocation,
        });
        if (geo?.latitude != null && geo?.longitude != null) {
          locSource = "resolved-geo";
          lat = geo.latitude;
          lon = geo.longitude;
          if (!label) label = dedupLabel([geo.district, geo.city, geo.region, geo.country]);
        } else if (geo?.city) {
          locSource = "resolved-geo-city";
          city = geo.city;
          if (!label) label = dedupLabel([geo.city, geo.region, geo.country]);
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

    console.log(
      `[weather.get_local] 位置来源=${locSource} 坐标=${lat.toFixed(4)},${lon.toFixed(4)} label=${label || "-"} city=${city || "-"}`,
    );
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
