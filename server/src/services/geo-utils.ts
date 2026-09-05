/**
 * 地理计算纯函数：Haversine 距离 + DBSCAN 聚类。
 * 位置历史（常去地点挖掘）与地理围栏（enter/leave 判定）共用，无任何副作用。
 */

export type GeoPointLike = { latitude: number; longitude: number };

const EARTH_RADIUS_METERS = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** 两点球面距离（米，Haversine 公式）。 */
export function haversineMeters(a: GeoPointLike, b: GeoPointLike): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(s)));
}

export type DbscanResult<T extends GeoPointLike> = {
  /** 成簇的样本分组（每簇至少 minPoints 个点，簇内两两距离链 ≤ epsMeters） */
  clusters: T[][];
  /** 未成簇的噪声点（不构成常去地点） */
  noise: T[];
};

/**
 * DBSCAN 密度聚类（经纬度度量的平面近似版：距离用 Haversine 米数）。
 * 位置轨迹量级（7 天 × 5 分钟 ≈ 2000 点）下 O(n²) 足够快，不引入依赖。
 */
export function dbscan<T extends GeoPointLike>(
  points: T[],
  epsMeters: number,
  minPoints: number,
): DbscanResult<T> {
  const n = points.length;
  const labels = new Array<number>(n).fill(-1); // -1=未访问, -2=噪声, ≥0=簇号
  const clusters: T[][] = [];
  const noise: T[] = [];
  let clusterId = 0;

  const neighbors = (i: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < n; j++) {
      if (haversineMeters(points[i], points[j]) <= epsMeters) out.push(j);
    }
    return out;
  };

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;
    const nbrs = neighbors(i);
    if (nbrs.length < minPoints) {
      labels[i] = -2;
      noise.push(points[i]);
      continue;
    }
    // 新簇：种子集合扩张
    const members: number[] = [i];
    labels[i] = clusterId;
    const queue = [...nbrs];
    while (queue.length > 0) {
      const j = queue.shift()!;
      if (labels[j] === -2) labels[j] = clusterId; // 噪声点可被簇吸收
      if (labels[j] !== -1) continue;
      labels[j] = clusterId;
      members.push(j);
      const nbrs2 = neighbors(j);
      if (nbrs2.length >= minPoints) queue.push(...nbrs2);
    }
    clusters.push(members.map((idx) => points[idx]));
    clusterId += 1;
  }

  return { clusters, noise };
}
