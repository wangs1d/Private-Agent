/**
 * redact 凭据脱敏行为测试（2026-09-24，铁律三：凭据不进模型上下文）。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { redactCredentials, redactDeep } = await import("../src/security/redact.js");

test("Cookie/Set-Cookie 头整值脱敏（保留前 4 位指纹）", () => {
  const input = "请求失败: Cookie: cna=abcdef123456; thw=cn; t=deadbeefcafe";
  const out = redactCredentials(input);
  assert.ok(!out.includes("abcdef123456"), "cookie 值不得出现在输出中");
  assert.ok(out.includes("cna=…<redacted>") || out.includes("cna…"), out);
});

test("Authorization 头脱敏", () => {
  const out = redactCredentials("Authorization: Bearer sk-abcdefghijk 剩余配额不足");
  assert.ok(!out.includes("sk-abcdefghijk"));
});

test("键值对形态的 password/token/secret 脱敏", () => {
  const cases = [
    "password=hunter2secret",
    "token=eyJhbGciOiJIUzI1NiJ9.xxx.yyy",
    "app_secret=a1b2c3d4e5f6g7h8",
    "access_token=AT-1234567890abcdef",
  ];
  for (const c of cases) {
    const out = redactCredentials(`参数错误于 ${c} 附近`);
    assert.ok(!out.includes(c.split("=")[1]!), `${c} 应被脱敏 → ${out}`);
  }
});

test("普通业务文本原样通过（不误伤）", () => {
  const text = "伊利纯牛奶 250ml*12盒 最低 ¥52.3（taobao）";
  assert.equal(redactCredentials(text), text);
});

test("redactDeep：嵌套结构内字符串递归脱敏、非字符串原样", () => {
  const input = {
    ok: false,
    error: "失败 Cookie: session=supersecretvalue",
    groups: [{ minPriceCny: 52.3, note: null }],
    nested: { url: "https://x.com?a=1&token=qwertyuiop123" },
  };
  const out = redactDeep(input) as typeof input;
  assert.equal(out.groups[0]!.minPriceCny, 52.3);
  assert.ok(!JSON.stringify(out).includes("supersecretvalue"));
  assert.ok(!JSON.stringify(out).includes("qwertyuiop123"));
});
