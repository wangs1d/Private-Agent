import assert from "node:assert/strict";

import { InternetIntelligenceService } from "../src/services/internet-intelligence-service.js";
import { registerInternetIntelligenceTools } from "../src/tools/internet-intelligence-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";

const calls = {
  search: 0,
  page: 0,
  weather: 0,
};

const service = new InternetIntelligenceService({
  search: {
    async searchUnified(input) {
      calls.search++;
      return {
        provider: "mock",
        platform: input.platform ?? "auto",
        notes: [],
        items: [
          {
            title: `Official update for ${input.query}`,
            url: "https://example.gov/update",
            snippet: "Official source says the service is operating normally today with one minor delay.",
            source: "official.gov",
            platform: "web",
          },
          {
            title: `Recent user report for ${input.query}`,
            url: "https://social.example/post/1",
            snippet: "A recent public post reports a short queue and normal conditions.",
            source: "xiaohongshu",
            platform: "xiaohongshu",
          },
          {
            title: `Public image evidence for ${input.query}`,
            url: "https://cdn.example.com/live/photo.jpg",
            snippet: "A public photo candidate from the live scene.",
            source: "public-cdn",
            platform: "image",
          },
        ],
      };
    },
  },
  pages: {
    async readWebpage(url) {
      calls.page++;
      return {
        title: `Fetched ${url}`,
        summary: "Fetched page confirms the official status and explains the minor delay.",
        content:
          "Fetched page confirms the official status and explains the minor delay. Extra body text should be compressed and should not flood the tool result.",
      };
    },
  },
  weather: {
    async getBrief(latitude, longitude, timezone, locationLabel) {
      calls.weather++;
      return {
        source: "open-meteo",
        latitude,
        longitude,
        timezone,
        locationLabel: locationLabel ?? "mock-place",
        currentTempC: 22,
        apparentTempC: 22,
        humidityPct: 60,
        windKmh: 8,
        precipitationMm: 0,
        weatherCode: 2,
        weatherText: "cloudy",
        todayMinC: 18,
        todayMaxC: 25,
        peakRainPct: 10,
        clothingAdvice: "Light jacket is enough.",
        summaryLine: "Mock place is cloudy, around 22C, low rain risk.",
        hourlyForecast: [],
      };
    },
  },
});

const ctx: ToolContext = {
  sessionId: "test-session",
  userId: "test-user",
  agentAccessMode: "full",
};

async function testResearchCompression() {
  const result = await service.research({
    goal: "Is the mock service status normal today?",
    depth: "deep",
    maxEvidence: 4,
    fetchTopPages: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "research");
  assert.ok(result.evidence.length <= 4);
  assert.ok(result.coverage.fetchedPageCount <= 2);
  assert.ok(result.tokenPolicy.compressed);
  assert.ok(result.tokenPolicy.estimatedResultTokens < 1800);
  assert.ok(result.evidence.every((item) => item.text.length <= 420));
  assert.ok(result.evidence.some((item) => item.media?.imageUrls.some((url) => url.endsWith("/live/photo.jpg"))));
}

async function testLiveCheckWeather() {
  const result = await service.liveCheck(
    {
      target: "mock place live condition now",
      latitude: 30,
      longitude: 120,
      depth: "quick",
      maxEvidence: 3,
    },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.mode, "live_check");
  assert.ok(result.evidence.some((item) => item.platform === "weather"));
  assert.ok(result.evidence.length <= 3);
}

async function testToolRegistryCache() {
  const registry = new ToolRegistry();
  registerInternetIntelligenceTools(registry, service);
  const before = calls.search;
  const first = await registry.execute(
    "internet.research",
    { goal: "cache smoke test", depth: "quick", maxEvidence: 2 },
    ctx,
  );
  const afterFirst = calls.search;
  const second = await registry.execute(
    "internet.research",
    { goal: "cache smoke test", depth: "quick", maxEvidence: 2 },
    ctx,
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(afterFirst, before + 1);
  assert.equal(calls.search, afterFirst);
}

async function main() {
  await testResearchCompression();
  await testLiveCheckWeather();
  await testToolRegistryCache();
  console.log("internet intelligence tests passed");
  console.log(JSON.stringify(calls));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
