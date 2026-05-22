/**
 * 根据公网 IP 解析大致地理位置（用于 App 展示网络出口位置，非 GPS 兜底）。
 */

const FETCH_TIMEOUT_MS = 8_000;

export type IpGeolocationHit = {
  ip: string;
  city: string;
  region: string;
  country: string;
  district: string;
  timezone: string;
  label: string;
  source: string;
};

function buildLabel(hit: {
  city?: string;
  region?: string;
  country?: string;
}): string {
  return [hit.city, hit.region, hit.country].filter(Boolean).join(" · ");
}

function isPrivateOrLoopback(ip: string): boolean {
  const trimmed = ip.trim();
  if (!trimmed || trimmed === "::1") return true;
  if (trimmed.startsWith("::ffff:")) {
    const v4 = trimmed.slice("::ffff:".length);
    return isPrivateOrLoopback(v4);
  }
  if (/^127\./.test(trimmed) || trimmed === "localhost") return true;
  if (/^10\./.test(trimmed)) return true;
  if (/^192\.168\./.test(trimmed)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(trimmed)) return true;
  if (/^169\.254\./.test(trimmed)) return true;
  if (/^0\./.test(trimmed)) return true;
  return false;
}

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn("[IpGeolocation] HTTP 失败:", url, res.status);
      return null;
    }
    return (await res.json()) as unknown;
  } catch (error) {
    console.warn("[IpGeolocation] 请求异常:", url, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOutboundPublicIp(): Promise<string | null> {
  const data = (await fetchJson("https://api.ipify.org?format=json")) as { ip?: string } | null;
  const ip = data?.ip?.trim();
  return ip && !isPrivateOrLoopback(ip) ? ip : null;
}

async function lookupIpApi(ip: string): Promise<IpGeolocationHit | null> {
  const fields =
    "status,message,query,country,regionName,city,timezone";
  const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}&lang=zh-CN`;
  const data = (await fetchJson(url)) as {
    status?: string;
    query?: string;
    country?: string;
    regionName?: string;
    city?: string;
    timezone?: string;
  } | null;
  if (!data || data.status !== "success") return null;

  const city = data.city?.trim() ?? "";
  const region = data.regionName?.trim() ?? "";
  const country = data.country?.trim() ?? "";
  const resolvedIp = data.query?.trim() || ip;
  const label = buildLabel({ city, region, country });

  return {
    ip: resolvedIp,
    city,
    region,
    country,
    district: "",
    timezone: data.timezone?.trim() || "Asia/Shanghai",
    label: label || resolvedIp,
    source: "ip-api",
  };
}

/** 解析客户端连接 IP；私网/本机时改用服务端公网出口 IP。 */
export async function resolveIpGeolocation(clientIp?: string): Promise<IpGeolocationHit | null> {
  let ip = clientIp?.trim() ?? "";
  if (!ip || isPrivateOrLoopback(ip)) {
    const outbound = await fetchOutboundPublicIp();
    if (!outbound) return null;
    ip = outbound;
  }
  return lookupIpApi(ip);
}
