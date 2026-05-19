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
