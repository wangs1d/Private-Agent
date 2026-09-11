/**
 * 用户称呼解析（appellation.ts）单测。
 *
 * 业务硬规则：问候/播报绝不直呼用户大名。
 *   1. 用户明确指定的称呼最优先（可称"王哥"/叫我老王/（用户指定）标记）；
 *   2. 记录值已是得体称呼（王哥/王先生/老王/王总/Tony）→ 原样使用；
 *   3. 记录值是连名带姓的大名（王铭川/欧阳文山）→ 转「姓氏+先生」；
 *   4. 解析失败 → 空串（问候省略称呼），绝不回退成大名。
 *
 * 纯函数测试，无外部依赖。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePoliteAppellation,
  toPoliteAddress,
} from "../src/services/user-personalization/appellation.js";

test("resolvePoliteAppellation: 用户指定的称呼最优先（可称/叫我/昵称）", () => {
  // 晨报接口 docstring 的原始示例：大名 + 括号偏好 → 必须取「王哥」而不是大名
  assert.equal(
    resolvePoliteAppellation("王铭川（可称\"王哥\"）；自称「小弟」"),
    "王哥",
  );
  assert.equal(resolvePoliteAppellation("王铭川，可以叫我老王"), "老王");
  assert.equal(resolvePoliteAppellation("叫我小张"), "小张");
  assert.equal(resolvePoliteAppellation("昵称：老王"), "老王");
});

test("resolvePoliteAppellation: （用户指定）标记优先于大名得体化", () => {
  assert.equal(resolvePoliteAppellation("王铭川（用户指定）"), "王铭川");
  assert.equal(resolvePoliteAppellation("王哥（用户指定）"), "王哥");
});

test("resolvePoliteAppellation: 大名转「姓氏+先生」，绝不原样返回大名", () => {
  assert.equal(resolvePoliteAppellation("王铭川"), "王先生");
  assert.equal(resolvePoliteAppellation("王小明"), "王先生");
  assert.equal(resolvePoliteAppellation("欧阳文山"), "欧阳先生");
  assert.equal(resolvePoliteAppellation("李芳"), "李先生");
});

test("resolvePoliteAppellation: 已是得体称呼/名字类昵称原样保留", () => {
  assert.equal(resolvePoliteAppellation("王哥"), "王哥");
  assert.equal(resolvePoliteAppellation("王先生"), "王先生");
  assert.equal(resolvePoliteAppellation("老王"), "老王");
  assert.equal(resolvePoliteAppellation("小张"), "小张");
  assert.equal(resolvePoliteAppellation("Tony"), "Tony");
  // 首字不是常见姓氏 → 当名字类昵称（如用户要求"叫我铭川"）
  assert.equal(resolvePoliteAppellation("铭川"), "铭川");
});

test("resolvePoliteAppellation: 缺失/异常 → 空串", () => {
  assert.equal(resolvePoliteAppellation(""), "");
  assert.equal(resolvePoliteAppellation("   "), "");
  assert.equal(resolvePoliteAppellation("（可称）"), "");
});

test("toPoliteAddress: 边界形态", () => {
  // 复姓纯姓（2 字）不算大名
  assert.equal(toPoliteAddress("欧阳"), "欧阳");
  // 称谓尾缀/昵称前缀不动
  assert.equal(toPoliteAddress("王总"), "王总");
  assert.equal(toPoliteAddress("王女士"), "王女士");
  assert.equal(toPoliteAddress("阿强"), "阿强");
  // 非纯中文不动（含空格原样保留）
  assert.equal(toPoliteAddress("Kevin Wang"), "Kevin Wang");
  // 空串
  assert.equal(toPoliteAddress(""), "");
});
