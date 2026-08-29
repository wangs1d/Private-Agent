/**
 * isPlaceholderApiKey 单元测试
 *
 * 验证各种 key 格式的识别正确性。
 * 运行: cd server && npx tsx test/api-key-validator.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPlaceholderApiKey } from "../src/config/api-key-validator.js";

describe("isPlaceholderApiKey", () => {
  describe("空 / undefined / null", () => {
    it("undefined → placeholder", () => {
      assert.equal(isPlaceholderApiKey(undefined), true);
    });
    it("null → placeholder", () => {
      assert.equal(isPlaceholderApiKey(null), true);
    });
    it("空字符串 → placeholder", () => {
      assert.equal(isPlaceholderApiKey(""), true);
    });
    it("纯空格 → placeholder", () => {
      assert.equal(isPlaceholderApiKey("   "), true);
    });
  });

  describe("常见占位符模式", () => {
    it("sk-placeholder-xxx → placeholder", () => {
      assert.equal(isPlaceholderApiKey("sk-placeholder-replace-me"), true);
    });
    it("replace-me → placeholder", () => {
      assert.equal(isPlaceholderApiKey("sk-1234567890-replace-me"), true);
    });
    it("your-key-here → placeholder", () => {
      assert.equal(isPlaceholderApiKey("sk-your-key-here-1234567890"), true);
    });
    it("xxxxx → placeholder", () => {
      assert.equal(isPlaceholderApiKey("sk-xxxxx-xxxxx-xxxxx"), true);
    });
    it("dummy → placeholder", () => {
      assert.equal(isPlaceholderApiKey("sk-dummy-key-dummy-key"), true);
    });
    it("fake → placeholder", () => {
      assert.equal(isPlaceholderApiKey("sk-fake-key-fake-key"), true);
    });
    it("test-key → placeholder", () => {
      assert.equal(isPlaceholderApiKey("sk-test-key-test-key-test"), true);
    });
  });

  describe("长度防御", () => {
    it("长度 < 20 → placeholder", () => {
      assert.equal(isPlaceholderApiKey("sk-short"), true);
    });
    it("长度 = 20 但不以 sk- 开头 → placeholder", () => {
      assert.equal(isPlaceholderApiKey("abcdefghijklmnopqrst"), true);
    });
  });

  describe("前缀防御", () => {
    it("不以 sk- 开头 → placeholder", () => {
      assert.equal(isPlaceholderApiKey("pk-1234567890abcdefghij"), true);
    });
  });

  describe("真实 key（不应误判）", () => {
    it("OpenAI 官方 key 格式 → 真实", () => {
      const realKey = "sk-" + "a".repeat(48);
      assert.equal(isPlaceholderApiKey(realKey), false);
    });
    it("OpenAI project key 格式 → 真实", () => {
      const realKey = "sk-proj-" + "a".repeat(48);
      assert.equal(isPlaceholderApiKey(realKey), false);
    });
  });
});
