import type { VideoGrabService } from "../services/video-grab-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * 视频抓取工具注册：
 *   - video.grab     根据分享/播放链接解析视频信息（抖音/小红书/B站等国内平台，适配器自动路由）
 *   - video.platforms 查看当前支持的平台（便于排查/健康检查）
 */
export function registerVideoTools(
  toolRegistry: ToolRegistry,
  videoGrabService: VideoGrabService,
): void {
  toolRegistry.register("video.grab", async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) {
      return { provider: "none", platform: "other", notes: ["url 不能为空"] };
    }
    const info = await videoGrabService.grab(url);
    return {
      provider: info.provider,
      platform: info.platform,
      title: info.title,
      author: info.author,
      durationSeconds: info.durationSeconds,
      description: info.description,
      videoUrl: info.videoUrl,
      thumbnailUrl: info.thumbnailUrl,
      playPageUrl: info.playPageUrl,
      notes: info.notes,
    };
  });

  toolRegistry.register("video.platforms", async () => {
    const health = await videoGrabService.checkHealth();
    return {
      platforms: health.platforms,
      mcporterAvailable: health.mcporterAvailable,
      notes: health.notes,
    };
  });
}
