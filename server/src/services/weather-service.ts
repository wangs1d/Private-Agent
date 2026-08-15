/**
 * 使用 Open-Meteo 免费接口（无需 API Key）：预报 + 地理编码。
 * @see https://open-meteo.com/
 */

export type WeatherBrief = {
  source: "open-meteo";
  latitude: number;
  longitude: number;
  timezone: string;
  locationLabel: string;
  currentTempC: number;
  apparentTempC: number;
  humidityPct: number;
  windKmh: number;
  precipitationMm: number;
  weatherCode: number;
  weatherText: string;
  todayMinC: number;
  todayMaxC: number;
  peakRainPct: number;
  clothingAdvice: string;
  hourlyForecast: WeatherHourlyForecast[];
  summaryLine: string;
};

export type WeatherHourlyForecast = {
  time: string;
  hour: string;
  temperatureC: number;
  precipitationProbabilityPct: number;
  weatherCode: number;
  weatherText: string;
};

const WMO_TEXT: Record<number, string> = {
  0: "晴",
  1: "大部晴朗",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "中毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "阵雪",
  95: "雷暴",
  96: "雷暴伴冰雹",
  99: "强雷暴伴冰雹",
};

function wmoText(code: number): string {
  return WMO_TEXT[code] ?? `天气码 ${code}`;
}

export function buildClothingAdvice(b: {
  currentTempC: number;
  todayMinC: number;
  todayMaxC: number;
  peakRainPct: number;
  weatherCode: number;
  windKmh: number;
}): string {
  const t = b.currentTempC;
  const feelsCold = Math.min(b.todayMinC, t);
  const rainy = b.peakRainPct >= 40 || [61, 63, 65, 80, 81, 82, 95, 96, 99].includes(b.weatherCode);
  const snowy = [71, 73, 75, 77, 85, 86].includes(b.weatherCode);

  const layers: string[] = [];
  if (feelsCold < -5) {
    layers.push("厚羽绒服或棉服");
  } else if (feelsCold < 5) {
    layers.push("羽绒服、呢大衣或厚外套");
  } else if (feelsCold < 12) {
    layers.push("夹克、风衣或针织开衫");
  } else if (feelsCold < 20) {
    layers.push("薄外套或长袖叠穿");
  } else if (t < 28) {
    layers.push("长袖单穿或薄长袖");
  } else {
    layers.push("短袖、透气衣物");
  }

  if (t >= 28) {
    layers.push("注意防暑与补水");
  }
  if (b.windKmh >= 28) {
    layers.push("风力较大，可加防风外层");
  }
  if (rainy) {
    layers.push("携带雨具（伞或雨衣）");
  }
  if (snowy) {
    layers.push("防滑鞋、保暖手套与帽子");
  }
  if (b.todayMaxC - b.todayMinC >= 10) {
    layers.push("昼夜温差大，建议洋葱式穿脱");
  }

  return layers.join("；");
}

type GeocodeHit = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
};

export async function geocodeCity(name: string): Promise<GeocodeHit | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    name.trim(),
  )}&count=1&language=zh&format=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: GeocodeHit[] };
  const hit = data.results?.[0];
  if (!hit?.latitude || !hit?.longitude) return null;
  return hit;
}

export type ReverseGeocodeHit = {
  city: string;
  district: string;
  region: string;
  country: string;
  timezone: string;
};

/** @deprecated 使用 reverse-geocode-service */
export { reverseGeocodeCoordinates } from "./reverse-geocode-service.js";

export class WeatherService {
  async getBrief(
    latitude: number,
    longitude: number,
    timezone: string,
    locationLabel?: string,
  ): Promise<WeatherBrief> {
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      timezone,
      current: [
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "weather_code",
        "wind_speed_10m",
        "precipitation",
      ].join(","),
      hourly: ["temperature_2m", "precipitation_probability", "weather_code"].join(","),
      daily: ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_probability_max"].join(","),
      forecast_days: "2",
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new Error(`天气接口错误: ${res.status}`);
    }
    const raw = (await res.json()) as {
      current?: {
        temperature_2m?: number;
        relative_humidity_2m?: number;
        apparent_temperature?: number;
        weather_code?: number;
        wind_speed_10m?: number;
        precipitation?: number;
      };
      hourly?: {
        time?: string[];
        temperature_2m?: (number | null)[];
        precipitation_probability?: (number | null)[];
        weather_code?: (number | null)[];
      };
      daily?: {
        weather_code?: (number | null)[];
        temperature_2m_max?: (number | null)[];
        temperature_2m_min?: (number | null)[];
        precipitation_probability_max?: (number | null)[];
      };
    };

    const cur = raw.current ?? {};
    const code = Number(cur.weather_code ?? 0);
    const tMax = Number(raw.daily?.temperature_2m_max?.[0] ?? cur.temperature_2m ?? 0);
    const tMin = Number(raw.daily?.temperature_2m_min?.[0] ?? cur.temperature_2m ?? 0);
    const probs = raw.hourly?.precipitation_probability?.filter((x): x is number => x != null) ?? [];
    const peakRainPct = probs.length > 0 ? Math.max(...probs) : Number(raw.daily?.precipitation_probability_max?.[0] ?? 0);

    const currentTempC = Number(cur.temperature_2m ?? 0);
    const hourlyForecast = buildHourlyForecast(raw.hourly);
    const brief: WeatherBrief = {
      source: "open-meteo",
      latitude,
      longitude,
      timezone,
      locationLabel: locationLabel ?? `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
      currentTempC,
      apparentTempC: Number(cur.apparent_temperature ?? currentTempC),
      humidityPct: Number(cur.relative_humidity_2m ?? 0),
      windKmh: Number(cur.wind_speed_10m ?? 0),
      precipitationMm: Number(cur.precipitation ?? 0),
      weatherCode: code,
      weatherText: wmoText(code),
      todayMinC: tMin,
      todayMaxC: tMax,
      peakRainPct,
      clothingAdvice: buildClothingAdvice({
        currentTempC,
        todayMinC: tMin,
        todayMaxC: tMax,
        peakRainPct,
        weatherCode: code,
        windKmh: Number(cur.wind_speed_10m ?? 0),
      }),
      hourlyForecast,
      summaryLine: "",
    };

    // 构建明天预报摘要（用户常问"明天天气"）
    const tomorrowMax = raw.daily?.temperature_2m_max?.[1];
    const tomorrowMin = raw.daily?.temperature_2m_min?.[1];
    const tomorrowRainPct = raw.daily?.precipitation_probability_max?.[1];
    let tomorrowSummary = "";
    if (tomorrowMax != null && tomorrowMin != null) {
      const tomorrowText = wmoText(Number(raw.daily?.weather_code?.[1] ?? 0));
      const rainInfo = tomorrowRainPct != null ? `，降水概率 ${tomorrowRainPct}%` : "";
      tomorrowSummary = ` 明日${tomorrowText}，${tomorrowMin.toFixed(0)}–${tomorrowMax.toFixed(0)}°C${rainInfo}。`;
    }

    brief.summaryLine = `${brief.locationLabel} 当前约 ${currentTempC.toFixed(0)}°C（体感 ${brief.apparentTempC.toFixed(0)}°C），${brief.weatherText}；今日约 ${tMin.toFixed(0)}–${tMax.toFixed(0)}°C。${tomorrowSummary}`.trim();
    return brief;
  }
}

function buildHourlyForecast(raw: {
  time?: string[];
  temperature_2m?: (number | null)[];
  precipitation_probability?: (number | null)[];
  weather_code?: (number | null)[];
} | undefined): WeatherHourlyForecast[] {
  const times = raw?.time ?? [];
  const temps = raw?.temperature_2m ?? [];
  if (times.length === 0 || temps.length === 0) return [];

  const now = Date.now();
  let start = times.findIndex((time) => new Date(time).getTime() >= now);
  if (start < 0) start = 0;

  const forecast: WeatherHourlyForecast[] = [];
  for (let i = start; i < times.length && forecast.length < 6; i += 3) {
    const temp = temps[i];
    if (temp == null) continue;
    const time = times[i];
    const hour = time.slice(11, 13).replace(/^0/, "") || "0";
    const weatherCode = Number(raw?.weather_code?.[i] ?? 0);
    forecast.push({
      time,
      hour,
      temperatureC: Number(temp),
      precipitationProbabilityPct: Number(raw?.precipitation_probability?.[i] ?? 0),
      weatherCode,
      weatherText: wmoText(weatherCode),
    });
  }
  return forecast;
}
