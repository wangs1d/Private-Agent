import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * 构建 base 路径：
 * - AVATAR_PUBLIC_PATH=./          → 独立静态包（可部署到任意目录）
 * - AVATAR_PUBLIC_PATH=/assets/sphere/ → 自定义前缀
 * - 默认 ./ （相对路径，便于移植）
 *
 * PAI 项目内部署：npm run build:chat（覆盖为 /chat/assets/avatar/）
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const base = env.AVATAR_PUBLIC_PATH ?? "./";

  return {
    base,
    plugins: [react()],
    server: {
      port: 5180,
      open: true,
    },
    build: {
      outDir: "dist",
      sourcemap: true,
      rollupOptions: {
        input: {
          main: resolve(__dirname, "index.html"),
          embed: resolve(__dirname, "embed.html"),
          overlay: resolve(__dirname, "overlay.html"),
          free: resolve(__dirname, "free.html"),
        },
      },
    },
  };
});
