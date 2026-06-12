const EXPLICIT_PHONE_CALL_RE =
  /(?:打电话|拨打电话|电话提醒|电话通知|语音来电|语音通话|call me|phone me|call user|call the user|phone call)/i;

/**
 * 判断用户是否明确要求发起电话/来电。
 *
 * 这里刻意只抓“有动作意图”的表达，避免把“电话是什么”这类解释性提问误判成呼叫。
 */
export function isExplicitPhoneCallRequest(text: string): boolean {
  return EXPLICIT_PHONE_CALL_RE.test(text.trim());
}
