import { z } from "zod";

/** WebSocket `chat.user_message` 附带的前端定位（优先于 IP 地理库）。 */
export const clientLocationWireSchema = z.object({
  latitude: z.number().finite(),
  longitude: z.number().finite(),
  city: z.string().max(120).optional(),
  /** 区/县，如「红花岗区」 */
  district: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  timezone: z.string().max(80).optional(),
  /** 展示用，如「贵州省 · 遵义市」 */
  label: z.string().max(200).optional(),
});

export type ClientLocationWire = z.infer<typeof clientLocationWireSchema>;

export type ClientGeoContext = {
  clientIp?: string;
  clientLocation?: ClientLocationWire;
};

export function parseClientLocation(raw: unknown): ClientLocationWire | undefined {
  const parsed = clientLocationWireSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
