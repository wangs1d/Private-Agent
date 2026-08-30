import test from "node:test";
import assert from "node:assert/strict";

import { isExplicitPhoneCallRequest } from "../src/agent/phone-call-intent.js";

test("显式打电话请求被识别", () => {
  for (const text of [
    "给我打个电话",
    "帮我拨打妈妈的电话",
    "打电话提醒我三点开会",
    "用电话通知我一下",
    "please call me back",
    "can you phone me tonight",
  ]) {
    assert.equal(isExplicitPhoneCallRequest(text), true, `应命中: ${text}`);
  }
});

test("解释性/非动作的提问不误判为呼叫", () => {
  for (const text of [
    "电话是什么时候发明的",
    "电话号码帮我记一下",
    "手机没电了怎么办",
    "今天天气怎么样",
    "打开电话本看一下联系人",
  ]) {
    assert.equal(isExplicitPhoneCallRequest(text), false, `不应命中: ${text}`);
  }
});
