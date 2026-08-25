// ============================================
// 统一响应格式
// ============================================

export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
  timestamp: string;
}

export interface PaginatedData<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PaginationParams {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// ============================================
// 坐标与地理
// ============================================

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface BoundingBox {
  northEast: Coordinates;
  southWest: Coordinates;
}

// ============================================
// 用户相关
// ============================================

export interface User {
  id: string;
  username: string;
  email: string;
  avatar?: string;
  role: UserRole;
  preferences?: UserPreferences;
  createdAt: Date;
  updatedAt: Date;
}

export type UserRole = 'admin' | 'user' | 'guest';

export interface UserPreferences {
  favoriteCategories?: string[];
  budgetRange?: { min: number; max: number };
  travelStyle?: 'relaxed' | 'adventure' | 'cultural' | 'foodie';
  accessibilityNeeds?: string[];
}

export interface JwtPayload {
  userId: string;
  username: string;
  role: UserRole;
}

// ============================================
// 景点
// ============================================

export interface Attraction {
  id: string;
  name: string;
  description: string;
  category: AttractionCategory;
  location: Coordinates;
  address: string;
  images: string[];
  /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL（.ply/.splat/.ksplat） */
  splatUrl?: string;
  rating: number;
  reviewCount: number;
  priceInfo: PriceInfo;
  openingHours: OpeningHours;
  tags: string[];
  features: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type AttractionCategory =
  | 'natural'
  | 'historical'
  | 'cultural'
  | 'entertainment'
  | 'religious'
  | 'museum'
  | 'park'
  | 'other';

export interface PriceInfo {
  ticketPrice: number;
  currency: string;
  discountInfo?: string;
  freeForChildren?: boolean;
}

export interface OpeningHours {
  open: string; // "09:00"
  close: string; // "18:00"
  daysOfWeek: number[]; // 0=Sunday, 6=Saturday
  closedDates?: string[]; // ISO date strings
}

export interface Review {
  id: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  attractionId: string;
  rating: number;
  content: string;
  images?: string[];
  createdAt: Date;
  helpfulCount: number;
}

export interface CreateAttractionDto {
  name: string;
  description: string;
  category: AttractionCategory;
  latitude: number;
  longitude: number;
  address: string;
  ticketPrice?: number;
  openingHours?: { open: string; close: string };
  tags?: string[];
}

export interface UpdateAttractionDto extends Partial<CreateAttractionDto> {}

// ============================================
// 酒店
// ============================================

export interface Hotel {
  id: string;
  name: string;
  description: string;
  starRating: number;
  location: Coordinates;
  address: string;
  images: string[];
  /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL（.ply/.splat/.ksplat） */
  splatUrl?: string;
  amenities: string[];
  rooms: RoomType[];
  rating: number;
  reviewCount: number;
  priceRange: { min: number; max: number };
  contactInfo: ContactInfo;
  policies: HotelPolicies;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoomType {
  id: string;
  name: string;
  description: string;
  capacity: number;
  pricePerNight: number;
  amenities: string[];
  images: string[];
  /** 房间级 3DGS 实景素材 URL（可选，用于房型预览） */
  splatUrl?: string;
  availableCount: number;
  totalCount: number;
}

export interface Booking {
  id: string;
  userId: string;
  hotelId: string;
  roomId: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalPrice: number;
  status: BookingStatus;
  createdAt: Date;
}

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed';

export interface ContactInfo {
  phone: string;
  email?: string;
  website?: string;
}

export interface HotelPolicies {
  checkInTime: string;
  checkOutTime: string;
  cancellationPolicy: string;
  petPolicy?: string;
}

export interface CreateHotelDto {
  name: string;
  description: string;
  starRating: number;
  latitude: number;
  longitude: number;
  address: string;
  phone: string;
  amenities?: string[];
}

export interface CreateBookingDto {
  hotelId: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
}

// ============================================
// 餐厅
// ============================================

export interface Restaurant {
  id: string;
  name: string;
  description: string;
  cuisine: string;
  location: Coordinates;
  address: string;
  images: string[];
  /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL（.ply/.splat/.ksplat） */
  splatUrl?: string;
  menuItems: MenuItem[];
  rating: number;
  reviewCount: number;
  priceLevel: PriceLevel;
  openingHours: OpeningHours;
  contactInfo: ContactInfo;
  tags: string[];
  features: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type PriceLevel = 1 | 2 | 3 | 4;

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  image?: string;
  isRecommended?: boolean;
  allergens?: string[];
}

export interface CreateRestaurantDto {
  name: string;
  description: string;
  cuisine: string;
  latitude: number;
  longitude: number;
  address: string;
  phone: string;
  priceLevel?: PriceLevel;
  tags?: string[];
}

// ============================================
// 行程
// ============================================

export interface Itinerary {
  id: string;
  userId: string;
  title: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  days: ItineraryDay[];
  isPublic: boolean;
  shareCode?: string;
  status: ItineraryStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type ItineraryStatus = 'draft' | 'active' | 'completed' | 'archived';

export interface ItineraryDay {
  dayNumber: number;
  date: Date;
  items: ItineraryItem[];
}

export interface ItineraryItem {
  id: string;
  order: number;
  startTime: string;
  endTime: string;
  type: 'attraction' | 'hotel' | 'restaurant' | 'transport';
  referenceId: string;
  notes?: string;
}

export interface CreateItineraryDto {
  title: string;
  description?: string;
  startDate: string;
  endDate: string;
  isPublic?: boolean;
}

// ============================================
// 路线规划
// ============================================

export interface RoutePlan {
  id: string;
  itineraryId: string;
  userId: string;
  algorithm: RouteAlgorithm;
  waypoints: Waypoint[];
  segments: RouteSegment[];
  totalDistance: number;
  estimatedDuration: number;
  optimizationScore: number;
  createdAt: Date;
}

export type RouteAlgorithm = 'shortest' | 'optimal_experience' | 'time_priority' | 'scenic' | 'custom';

export interface Waypoint {
  id: string;
  order: number;
  name: string;
  location: Coordinates;
  type: 'attraction' | 'hotel' | 'restaurant' | 'custom';
  referenceId?: string;
  stayDuration?: number; // minutes
  arrivalTime?: string;
  departureTime?: string;
}

export interface RouteSegment {
  fromWaypointId: string;
  toWaypointId: string;
  distance: number; // meters
  duration: number; // minutes
  transportMode: TransportMode;
  instruction: string;
  polyline?: string;
  /** 真实道路几何 [lng,lat][]（由路网 API 返回） */
  geometry?: [number, number][];
  /** 几何来源：真实路网 or 直线降级 */
  geometrySource?: 'real-road' | 'fallback-straight';
}

export type TransportMode = 'walking' | 'driving' | 'transit' | 'cycling' | 'taxi';

export interface RouteRequest {
  waypoints: { latitude: number; longitude: number; name?: string }[];
  algorithm?: RouteAlgorithm;
  transportMode?: TransportMode;
  constraints?: RouteConstraints;
}

export interface RouteConstraints {
  maxDistance?: number;
  maxDuration?: number;
  mustVisitIds?: string[];
  avoidIds?: string[];
  startTime?: string;
  preferredCategories?: string[];
}

// ============================================
// 地图数据
// ============================================

export interface MapRegion {
  id: string;
  name: string;
  boundary: Coordinates[];
  center: Coordinates;
  zoom: number;
  poiCount: number;
}

export interface POI {
  id: string;
  name: string;
  type: POIType;
  location: Coordinates;
  address: string;
  rating?: number;
  regionId?: string;
  /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL（.ply/.splat/.ksplat） */
  splatUrl?: string;
}

export type POIType =
  | 'attraction'
  | 'hotel'
  | 'restaurant'
  | 'transport'
  | 'shopping'
  | 'medical'
  | 'bank'
  | 'atm'
  | 'toilet'
  | 'parking'
  | 'other';

// ============================================
// 文件上传
// ============================================

export interface UploadedFile {
  id: string;
  originalName: string;
  filename: string;
  mimetype: string;
  size: number;
  url: string;
  uploadedBy: string;
  createdAt: Date;
}

export type FileCategory = 'image' | 'document' | 'video' | 'audio' | 'other';

// ============================================
// 智能规划 Agent 系统
// ============================================

/** 用户实时状态 */
export interface UserState {
  userId: string;
  /** 当前位置 */
  currentLocation?: Coordinates;
  /** 起床时间（HH:mm） */
  wakeTime?: string;
  /** 疲劳度 0-1 */
  fatigueLevel?: number;
  /** 情绪标签 */
  mood?: 'happy' | 'neutral' | 'tired' | 'excited' | 'anxious';
  /** 状态来源 */
  source: 'manual' | 'inferred' | 'heartbeat';
  /** 时间戳 */
  timestamp: Date;
}

/** 天气数据 */
export interface WeatherData {
  /** 坐标 */
  location: Coordinates;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 逐小时天气 */
  hourly: HourlyWeather[];
  /** 数据来源 */
  source: 'real-api' | 'estimated';
}

export interface HourlyWeather {
  hour: number; // 0-23
  temperature: number;
  feelsLike: number;
  weatherCondition: WeatherCondition;
  precipitation: number; // mm
  windSpeed: number; // km/h
  uvIndex: number;
  isOutdoorFriendly: boolean;
}

export type WeatherCondition =
  | 'sunny' | 'cloudy' | 'overcast' | 'light-rain'
  | 'heavy-rain' | 'thunderstorm' | 'snow' | 'fog' | 'haze';

/** 实时交通数据 */
export interface TrafficData {
  /** 起点 */
  origin: Coordinates;
  /** 终点 */
  destination: Coordinates;
  /** 距离（米） */
  distance: number;
  /** 实时耗时（分钟） */
  duration: number;
  /** 拥堵系数（实际耗时/自由流耗时，1.0=畅通，≥1.5=拥堵） */
  congestionFactor: number;
  /** 交通方式 */
  transportMode: TransportMode;
  /** 数据来源 */
  source: 'real-api' | 'estimated';
}

/** 人群拥挤度数据 */
export interface CrowdData {
  /** POI 名称或 ID */
  poiId: string;
  /** 拥挤度指数 0-1（0=空旷，1=极度拥挤） */
  crowdIndex: number;
  /** 预测时段 */
  hour: number;
  /** 数据来源 */
  source: 'real-api' | 'estimated';
}

/** 外部因素聚合 */
export interface ExternalFactors {
  weather?: WeatherData;
  traffic?: TrafficData;
  crowd?: CrowdData;
}

/** 重规划事件 */
export interface ReplanEvent {
  /** 事件 ID */
  id: string;
  /** 事件类型 */
  type: ReplanEventType;
  /** 关联的行程 ID */
  itineraryId: string;
  /** 事件数据 */
  payload: UserStateChangedPayload | WeatherChangedPayload | CrowdChangedPayload | ManualReplanPayload;
  /** 时间戳 */
  timestamp: Date;
  /** 优先级 */
  priority: 'low' | 'medium' | 'high';
}

export type ReplanEventType =
  | 'user-state-changed'
  | 'weather-changed'
  | 'crowd-changed'
  | 'manual-replan';

export interface UserStateChangedPayload {
  userId: string;
  field: 'wakeTime' | 'location' | 'fatigueLevel' | 'mood';
  oldValue: unknown;
  newValue: unknown;
}

export interface WeatherChangedPayload {
  location: Coordinates;
  date: string;
  condition: WeatherCondition;
  severity: 'minor' | 'moderate' | 'severe';
}

export interface CrowdChangedPayload {
  poiId: string;
  oldIndex: number;
  newIndex: number;
}

export interface ManualReplanPayload {
  reason: string;
  userId: string;
}

/** 行程变更事件 */
export interface ItineraryChangedEvent {
  itineraryId: string;
  changeType: 'delay' | 'replace' | 'reorder';
  /** 变更前 */
  before: unknown;
  /** 变更后 */
  after: unknown;
  /** 变更原因 */
  reason: string;
  timestamp: Date;
}

/** Agent 推理追踪 */
export interface AgentTrace {
  /** 规划模式 */
  planningMode: 'agent' | 'fallback-rule';
  /** 推理步骤 */
  steps: AgentTraceStep[];
  /** 总耗时（ms） */
  totalDurationMs: number;
  /** 是否降级 */
  degraded: boolean;
  /** 降级原因 */
  degradeReason?: string;
}

export interface AgentTraceStep {
  /** 步骤序号 */
  step: number;
  /** 类型 */
  type: 'llm-reasoning' | 'tool-call' | 'tool-result';
  /** 工具名（type 为 tool-call/tool-result 时） */
  toolName?: string;
  /** 工具输入 */
  toolInput?: unknown;
  /** 工具输出 */
  toolOutput?: unknown;
  /** LLM 推理内容 */
  reasoning?: string;
  /** 耗时（ms） */
  durationMs: number;
  /** 数据来源标记 */
  dataSource?: 'real-api' | 'estimated';
}

/** 偏好档案 */
export interface PreferenceProfile {
  userId: string;
  /** 显式偏好 */
  explicit: ExplicitPreferences;
  /** 隐式偏好权重 */
  implicit: ImplicitPreferences;
  /** 偏好置信度 0-1 */
  confidence: number;
  /** 最后更新时间 */
  updatedAt: Date;
}

export interface ExplicitPreferences {
  /** 偏好户外 */
  outdoor: boolean;
  /** 偏好室内 */
  indoor: boolean;
  /** 偏好海边 */
  seaside: boolean;
  /** 偏好亲子 */
  kidsFriendly: boolean;
  /** 节奏 */
  pace: 'relaxed' | 'balanced' | 'intensive';
  /** 预算 */
  budget: 'low' | 'mid' | 'high';
  /** 菜系偏好 */
  cuisine: string[];
  /** 住宿档次 */
  hotelTier: 'budget' | 'mid' | 'luxury';
}

export interface ImplicitPreferences {
  /** 各维度权重 0-1，值越大表示越偏好 */
  outdoorWeight: number;
  indoorWeight: number;
  adventureWeight: number;
  culturalWeight: number;
  foodieWeight: number;
  /** 交互次数 */
  interactionCount: number;
}

/** 默认隐式偏好（新用户） */
export const DEFAULT_IMPLICIT_PREFERENCES: ImplicitPreferences = {
  outdoorWeight: 0.5,
  indoorWeight: 0.5,
  adventureWeight: 0.5,
  culturalWeight: 0.5,
  foodieWeight: 0.5,
  interactionCount: 0,
};

/** 默认显式偏好（新用户） */
export const DEFAULT_EXPLICIT_PREFERENCES: ExplicitPreferences = {
  outdoor: true,
  indoor: true,
  seaside: false,
  kidsFriendly: false,
  pace: 'balanced',
  budget: 'mid',
  cuisine: [],
  hotelTier: 'mid',
};
