import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSearchQueryVariants,
  filterItemsByRelevance,
} from "../src/services/domestic-web-providers.js";

test("query variants keep compare-oriented recall paths", () => {
  const variants = buildSearchQueryVariants("iPhone 17 和 iPhone 16 对比");

  assert.equal(variants.some((value) => value.includes("对比")), true);
  assert.equal(variants.some((value) => value.includes("iPhone 17")), true);
  assert.equal(variants.some((value) => value.includes("iPhone 16")), true);
});

test("relevance filter accepts results matching extracted entities", () => {
  const items = filterItemsByRelevance(
    [
      {
        title: "iPhone 17 对比 iPhone 16：电池和影像升级",
        url: "https://example.com/iphone-compare",
        snippet: "新机对比汇总",
        source: "example",
      },
      {
        title: "MacBook Air 新闻",
        url: "https://example.com/macbook-air",
        snippet: "和当前查询无关",
        source: "example",
      },
    ],
    "iPhone 17 和 iPhone 16 对比",
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.title.includes("iPhone 17"), true);
});
