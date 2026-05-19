/**
 * Agent World 地图配置 (MapLibre GL JS)
 * 
 * MapLibre GL JS 是 Mapbox GL JS 的开源分支，完全免费
 * 支持真正的矢量瓦片和 3D 建筑渲染
 * 文档：https://maplibre.org/
 * 
 * 设计理念：
 * - 初始视图：用户周围城市/乡镇，3D 倾斜视角展示附近 Agent
 * - 缩放后：省份级别大地图，俯瞰视角
 * - 视觉风格：纯暗黑色主题，类似 Mapbox GL JS 3D 渲染效果
 * - 真实 3D 建筑：使用矢量瓦片数据渲染高楼
 */

export const MAP_CONFIG = {
  // 地图初始视角（用户所在城市 - 以北京为例，实际应从用户位置获取）
  INITIAL_CENTER: [116.4074, 39.9042], // 北京 [经度, 纬度]
  INITIAL_ZOOM: 14, //  zoom 14 显示城市街区细节
  INITIAL_PITCH: 60,  // 初始倾斜 60 度，营造 3D 效果
  INITIAL_BEARING: -30, // 旋转 -30 度，增加立体感
  
  // 缩放级别对应的视角策略
  ZOOM_STRATEGY: {
    CITY_LEVEL: { min: 11, max: 15, pitch: 60 },   // 城市级别：高倾斜角 3D 效果
    REGION_LEVEL: { min: 8, max: 10, pitch: 45 },  // 区域级别：中等倾斜角
    PROVINCE_LEVEL: { min: 5, max: 7, pitch: 30 }, // 省份级别：低倾斜角
    NATIONAL_LEVEL: { min: 1, max: 4, pitch: 0 }   // 全国级别：俯瞰视角
  },
  
  // 地图样式配置 - 使用 Protomaps v5 API（支持真正的 3D 建筑）
  // 注册地址: https://protomaps.com/
  // 文档: https://protomaps.com/api
  // 
  // 可用的暗黑色主题样式：
  // - dark: 纯暗黑主题
  // - dark-gray: 深灰主题
  // - black: 纯黑主题
  //
  // 语言支持：en, zh, ja, ko, de, fr, es, ru 等
  // 将 'zh' 替换为你需要的语言代码
  STYLE_URL: 'https://api.protomaps.com/styles/v5/dark/zh.json?key=4d971e2597c8ca99',
  
  // 3D 建筑配置
  BUILDING_3D: {
    enabled: true,
    minZoom: 13,  // zoom >= 13 时显示 3D 建筑
    color: '#1a1a2e',
    opacity: 0.9,
    outlineColor: '#2d2d44',
    outlineWidth: 1
  },
  
  // Agent 标记配置
  AGENT_MARKER: {
    nearbyRadius: 50,  // 附近 Agent 半径（公里）
    pulseAnimation: true,  // 脉冲动画
    glowEffect: true,  // 发光效果
    colors: {
      active: '#00ff88',   // 活跃 - 绿色荧光
      busy: '#ffaa00',     // 忙碌 - 橙色
      idle: '#666666'      // 空闲 - 灰色
    }
  }
};
