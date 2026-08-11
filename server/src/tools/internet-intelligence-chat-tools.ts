import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const INTERNET_INTELLIGENCE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "internet.research",
      description:
        "High-level internet research. Use for current facts, companies, people, products, policies, events, reviews, and cross-source evidence. Returns compressed evidence cards instead of raw pages to save tokens.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The research goal or question." },
          depth: { type: "string", enum: ["quick", "normal", "deep"], description: "Default normal. Deep may fetch top pages." },
          timeWindow: { type: "string", enum: ["15m", "1h", "6h", "24h", "7d"] },
          maxEvidence: { type: "integer", description: "Hard cap for returned evidence cards. Default depends on depth." },
          fetchTopPages: { type: "boolean", description: "Fetch 1-2 top web pages for deeper evidence. Default true only for deep." },
        },
        required: ["goal"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "internet.live_check",
      description:
        "Check a live situation using compressed multi-source evidence. Use for now/today/live status, weather, crowd, outages, events, traffic, availability, or fast-changing local conditions.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "What to check right now." },
          goal: { type: "string", description: "Alias for target." },
          locationName: { type: "string" },
          latitude: { type: "number" },
          longitude: { type: "number" },
          timezone: { type: "string" },
          depth: { type: "string", enum: ["quick", "normal", "deep"] },
          timeWindow: { type: "string", enum: ["15m", "1h", "6h", "24h", "7d"] },
          maxEvidence: { type: "integer" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "internet.verify",
      description:
        "Verify a claim with fresh cross-source evidence. Returns stance, confidence, gaps, and compact evidence cards.",
      parameters: {
        type: "object",
        properties: {
          claim: { type: "string" },
          depth: { type: "string", enum: ["quick", "normal", "deep"] },
          maxEvidence: { type: "integer" },
        },
        required: ["claim"],
        additionalProperties: false,
      },
    },
  },
];
