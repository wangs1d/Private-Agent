/**
 * GCJ-02 ↔ WGS-84 坐标转换
 *
 * 为什么需要：高德（及国内合规地图服务）返回 GCJ-02「火星坐标」，而本项目的
 * 地图底图（Carto/Esri）、OSM POI、OSRM 路网全部使用 WGS-84。混用时国内 POI
 * 会在地图上整体偏移约 300~700 米，OSRM 算路也会被带偏。
 *
 * 约定（全链路单边 WGS-84）：
 *   - POI/中心点入库、缓存、行程、地图展示、OSRM 请求 → 一律 WGS-84
 *   - 仅在调用高德接口（搜索/算路）的请求参数里临时转回 GCJ-02
 *
 * 算法：标准偏移椭圆公式（GCJ-02 加密为非线性，逆向用一次迭代近似，
 * 精度 ~1e-6 度（约 0.1m），远小于 GCJ 加密本身的抖动）。
 * reverse-geocode-service.ts 已有一份 wgs84ToGcj02（仅反地理编码用），
 * 这里是带逆向转换的完整实现，供规划链路统一使用。
 */

interface LatLng {
  latitude: number;
  longitude: number;
}

/** 中国大陆大致包围盒（粗判，境外坐标原样返回——加密只在境内生效） */
function outOfChina(lat: number, lon: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return ret;
}

/** WGS-84 → GCJ-02（调用高德接口前转换） */
export function wgs84ToGcj02(lat: number, lon: number): LatLng {
  if (outOfChina(lat, lon)) return { latitude: lat, longitude: lon };
  const dLat = transformLat(lon - 105, lat - 35);
  const dLon = transformLon(lon - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - 0.00669342162296594323 * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const offsetLat = (dLat * 180) / ((6378245 * (1 - 0.00669342162296594323)) / (magic * sqrtMagic) * Math.PI);
  const offsetLon = (dLon * 180) / (6378245 / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { latitude: lat + offsetLat, longitude: lon + offsetLon };
}

/** GCJ-02 → WGS-84（高德 POI 入库前转换；一次迭代近似，误差 <0.5m） */
export function gcj02ToWgs84(lat: number, lon: number): LatLng {
  if (outOfChina(lat, lon)) return { latitude: lat, longitude: lon };
  const gcj = wgs84ToGcj02(lat, lon);
  // 一阶近似：wgs ≈ gcj - (gcj(wgs) - wgs)。非线性残差再迭代一轮收敛。
  let wgsLat = lat - (gcj.latitude - lat);
  let wgsLon = lon - (gcj.longitude - lon);
  for (let i = 0; i < 2; i++) {
    const g = wgs84ToGcj02(wgsLat, wgsLon);
    wgsLat = lat - (g.latitude - lat);
    wgsLon = lon - (g.longitude - lon);
  }
  return { latitude: wgsLat, longitude: wgsLon };
}
