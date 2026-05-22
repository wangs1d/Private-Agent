/**

 * 时钟工具：获取当前时间和日期信息

 * 优先使用前端 GPS 定位，结合本地时间提供准确的时间信息

 */



import {

  formatUserLocationLabel,

  resolveUserGeo,

  type UserGeoInfo,

} from "../services/user-location-service.js";

import type { ToolRegistry } from "./tool-registry.js";



export type { UserGeoInfo as UserTimezoneInfo } from "../services/user-location-service.js";

export { resolveUserGeo as getUserTimezoneByIP } from "../services/user-location-service.js";



function geoCtx(context: { clientIp?: string; clientLocation?: import("../types/client-location.js").ClientLocationWire }) {

  return {

    clientIp: context.clientIp,

    clientLocation: context.clientLocation,

  };

}



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



function getWeekdayInTimezone(date: Date, timezone: string): string {

  return date.toLocaleString("zh-CN", {

    timeZone: timezone,

    weekday: "long",

  });

}



function locationField(info: UserGeoInfo): string {

  return formatUserLocationLabel(info);

}



function buildLocationToolResult(info: UserGeoInfo): Record<string, unknown> {

  const label = locationField(info);

  const sourceHint = info.source === "client-gps" || info.source === "bigdatacloud" || info.source === "amap"
    ? "GPS 定位"
    : "设备定位";

  return {

    ok: true,

    city: info.city,

    region: info.region,

    country: info.country,

    timezone: info.timezone,

    location: label,

    latitude: info.latitude,

    longitude: info.longitude,

    geoSource: info.source,

    message: label

      ? `根据${sourceHint}，您当前位于：${label}${info.timezone ? `（时区 ${info.timezone}）` : ""}`

      : "暂时无法识别您的所在城市，请在 App 中开启定位权限后重试。",

  };

}



function noLocationError(): Record<string, unknown> {

  return {

    ok: false,

    error: "无法获取您的位置。请在 App/浏览器中开启定位权限，以便识别您所在的城市。",

  };

}



export function registerClockTools(toolRegistry: ToolRegistry): void {

  toolRegistry.register("clock.get_user_location", async (_input, context) => {

    const userInfo = await resolveUserGeo(geoCtx(context));

    if (!userInfo || (!userInfo.city && !userInfo.region)) {

      return noLocationError();

    }

    return buildLocationToolResult(userInfo);

  });



  toolRegistry.register("clock.get_current_time", async (_input, context) => {

    const now = new Date();

    const utc = now.toUTCString();



    const userInfo = await resolveUserGeo(geoCtx(context));

    const timezone = userInfo?.timezone?.trim() || "Asia/Shanghai";



    const localTime = formatTimeInTimezone(now, timezone);

    const weekday = getWeekdayInTimezone(now, timezone);

    const label = userInfo ? locationField(userInfo) : timezone;



    return {

      ok: true,

      currentTime: {

        utc,

        local: localTime,

        weekday,

        timestamp: now.toISOString(),

        unixTimestamp: Math.floor(now.getTime() / 1000),

      },

      timezone,

      location: label,

      geoSource: userInfo?.source ?? "fallback",

      message: `当前时间（${userInfo?.city || label}）：${localTime} ${weekday}`,

    };

  });



  toolRegistry.register("clock.get_date", async (_input, context) => {

    const now = new Date();



    const userInfo = await resolveUserGeo(geoCtx(context));

    const timezone = userInfo?.timezone?.trim() || "Asia/Shanghai";



    const localDate = now.toLocaleString("zh-CN", {

      timeZone: timezone,

      year: "numeric",

      month: "long",

      day: "numeric",

      weekday: "long",

    });



    const label = userInfo ? locationField(userInfo) : "Asia/Shanghai";



    return {

      ok: true,

      currentDate: localDate,

      timezone: label,

      geoSource: userInfo?.source ?? "fallback",

      timestamp: now.toISOString(),

      message: `今天日期（${userInfo?.city || "本地"}）：${localDate}`,

    };

  });



  toolRegistry.register("clock.format_timestamp", async (input, context) => {

    const timestamp = Number(input.timestamp);

    if (!Number.isFinite(timestamp)) {

      return {

        ok: false,

        error: "时间戳必须是有效数字",

      };

    }



    const date = new Date(timestamp * 1000);



    const userInfo = await resolveUserGeo(geoCtx(context));

    const timezone = userInfo?.timezone?.trim() || "Asia/Shanghai";



    const formatted = formatTimeInTimezone(date, timezone);

    const weekday = getWeekdayInTimezone(date, timezone);



    return {

      ok: true,

      formatted: `${formatted} ${weekday}`,

      timezone: userInfo ? locationField(userInfo) : "Asia/Shanghai",

      geoSource: userInfo?.source ?? "fallback",

      timestamp,

      isoString: date.toISOString(),

    };

  });

}


