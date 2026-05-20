/**
 * 时钟工具：获取当前时间和日期信息
 * 通过 IP 地址查询用户所在时区，结合本地时间提供准确的时间信息
 */

import type { ToolRegistry } from "./tool-registry.js";

export type UserTimezoneInfo = {
  timezone: string;
  country: string;
  city: string;
  ip: string;
  source: "ip-api" | "ipwho.is";
};

const FETCH_TIMEOUT_MS = 5_000;

async function fetchJsonWithTimeout(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      console.warn("[ClockTools] HTTP 查询失败:", url, response.status);
      return null;
    }
    return (await response.json()) as unknown;
  } catch (error) {
    console.warn("[ClockTools] 查询异常:", url, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromIpApi(): Promise<UserTimezoneInfo | null> {
  const data = (await fetchJsonWithTimeout(
    "http://ip-api.com/json/?fields=status,message,timezone,country,city,query",
  )) as Record<string, string> | null;
  if (!data) return null;
  if (data.status === "fail") {
    console.warn("[ClockTools] ip-api 失败:", data.message);
    return null;
  }
  if (!data.timezone?.trim()) return null;
  return {
    timezone: data.timezone.trim(),
    country: data.country ?? "",
    city: data.city ?? "",
    ip: data.query ?? "",
    source: "ip-api",
  };
}

async function fetchFromIpWhoIs(): Promise<UserTimezoneInfo | null> {
  const data = (await fetchJsonWithTimeout("https://ipwho.is/")) as Record<string, unknown> | null;
  if (!data || data.success !== true) return null;
  const tz = data.timezone as { id?: string } | string | undefined;
  const timezone =
    typeof tz === "string" ? tz.trim() : typeof tz?.id === "string" ? tz.id.trim() : "";
  if (!timezone) return null;
  return {
    timezone,
    country: String(data.country ?? ""),
    city: String(data.city ?? ""),
    ip: String(data.ip ?? ""),
    source: "ipwho.is",
  };
}

async function fetchFromIpApiCo(): Promise<UserTimezoneInfo | null> {
  const data = (await fetchJsonWithTimeout("https://ipapi.co/json/")) as Record<string, unknown> | null;
  if (!data || data.error) return null;
  const timezone = String(data.timezone ?? "").trim();
  if (!timezone) return null;
  return {
    timezone,
    country: String(data.country_name ?? data.country ?? ""),
    city: String(data.city ?? ""),
    ip: String(data.ip ?? ""),
    source: "ip-api",
  };
}

async function fetchFromWorldTimeApi(): Promise<UserTimezoneInfo | null> {
  const data = (await fetchJsonWithTimeout("https://worldtimeapi.org/api/ip")) as Record<
    string,
    unknown
  > | null;
  if (!data) return null;
  const timezone = String(data.timezone ?? "").trim();
  if (!timezone) return null;
  return {
    timezone,
    country: "",
    city: String(data.timezone ?? "").split("/").pop() ?? "",
    ip: "",
    source: "ip-api",
  };
}

function timezoneFromEnv(): UserTimezoneInfo | null {
  const tz = process.env.AGENT_CLOCK_DEFAULT_TIMEZONE?.trim();
  if (!tz) return null;
  return {
    timezone: tz,
    country: "",
    city: tz,
    ip: "",
    source: "ip-api",
  };
}

/**
 * 通过 IP 地址查询用户所在时区（多源降级；可用 AGENT_CLOCK_DEFAULT_TIMEZONE 跳过公网查询）。
 */
export async function getUserTimezoneByIP(): Promise<UserTimezoneInfo | null> {
  const fromEnv = timezoneFromEnv();
  if (fromEnv) return fromEnv;

  const chain = [fetchFromIpApi, fetchFromIpApiCo, fetchFromWorldTimeApi, fetchFromIpWhoIs];
  for (const fn of chain) {
    const hit = await fn();
    if (hit) return hit;
  }
  return null;
}

/**
 * 格式化时间为指定时区的本地时间
 */
function formatTimeInTimezone(
  date: Date,
  timezone: string,
  includeSeconds = true,
): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };

  if (includeSeconds) {
    options.second = "2-digit";
  }

  return date.toLocaleString("zh-CN", options);
}

/**
 * 获取星期几
 */
function getWeekdayInTimezone(date: Date, timezone: string): string {
  return date.toLocaleString("zh-CN", {
    timeZone: timezone,
    weekday: "long",
  });
}

export function registerClockTools(toolRegistry: ToolRegistry): void {
  toolRegistry.register("clock.get_current_time", async () => {
    const now = new Date();
    const utc = now.toUTCString();

    const userInfo = await getUserTimezoneByIP();

    if (userInfo?.timezone) {
      const localTime = formatTimeInTimezone(now, userInfo.timezone);
      const weekday = getWeekdayInTimezone(now, userInfo.timezone);

      return {
        ok: true,
        currentTime: {
          utc,
          local: localTime,
          weekday,
          timestamp: now.toISOString(),
          unixTimestamp: Math.floor(now.getTime() / 1000),
        },
        timezone: userInfo.timezone,
        location: `${userInfo.city}, ${userInfo.country}`.replace(/^, |, $/g, "").trim() || userInfo.timezone,
        ip: userInfo.ip,
        geoSource: userInfo.source,
        message: `当前时间（${userInfo.city || userInfo.timezone}）：${localTime} ${weekday}`,
      };
    }

    const localTime = formatTimeInTimezone(now, "Asia/Shanghai");
    const weekday = getWeekdayInTimezone(now, "Asia/Shanghai");

    return {
      ok: true,
      currentTime: {
        utc,
        beijing: localTime,
        weekday,
        timestamp: now.toISOString(),
        unixTimestamp: Math.floor(now.getTime() / 1000),
      },
      timezone: "Asia/Shanghai (UTC+8)",
      geoSource: "fallback",
      message: `当前北京时间：${localTime} ${weekday}`,
    };
  });

  toolRegistry.register("clock.get_date", async () => {
    const now = new Date();

    const userInfo = await getUserTimezoneByIP();
    const timezone = userInfo?.timezone || "Asia/Shanghai";

    const localDate = now.toLocaleString("zh-CN", {
      timeZone: timezone,
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    });

    return {
      ok: true,
      currentDate: localDate,
      timezone: userInfo ? `${userInfo.city}, ${userInfo.country}` : "Asia/Shanghai",
      geoSource: userInfo?.source ?? "fallback",
      timestamp: now.toISOString(),
      message: `今天日期（${userInfo?.city || "本地"}）：${localDate}`,
    };
  });

  toolRegistry.register("clock.format_timestamp", async (input) => {
    const timestamp = Number(input.timestamp);
    if (!Number.isFinite(timestamp)) {
      return {
        ok: false,
        error: "时间戳必须是有效数字",
      };
    }

    const date = new Date(timestamp * 1000);

    const userInfo = await getUserTimezoneByIP();
    const timezone = userInfo?.timezone || "Asia/Shanghai";

    const formatted = formatTimeInTimezone(date, timezone);
    const weekday = getWeekdayInTimezone(date, timezone);

    return {
      ok: true,
      formatted: `${formatted} ${weekday}`,
      timezone: userInfo ? `${userInfo.city}, ${userInfo.country}` : "Asia/Shanghai",
      geoSource: userInfo?.source ?? "fallback",
      timestamp,
      isoString: date.toISOString(),
    };
  });
}
