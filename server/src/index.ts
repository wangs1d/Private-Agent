import "dotenv/config";
import { createAppServices } from "./bootstrap/create-app-services.js";
import { getRuntimeConfig } from "./config/env.js";
import { initializeRuntimeState } from "./bootstrap/initialize-runtime-state.js";

const runtime = getRuntimeConfig();
const services = await createAppServices();
await initializeRuntimeState(services);
await services.app.listen({
  port: runtime.port,
  host: "0.0.0.0",
});
const socialUrl = process.env.SOCIAL_PLATFORM_PUBLIC_URL?.trim() || "http://127.0.0.1:3001";
const worldStandalone = process.env.AGENT_WORLD_STANDALONE_URL?.trim() || "http://127.0.0.1:3333";
console.log(
  `[dev] server http://127.0.0.1:${runtime.port} | Agent World ${worldStandalone} | 社交推文 ${socialUrl}`,
);
