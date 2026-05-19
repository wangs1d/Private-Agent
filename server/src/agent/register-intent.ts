/**
 * 解析「注册账号 / 创建账号 / 开户」及可选「名称:」「昵称:」或单行名称。
 */
export function parseRegisterIntent(text: string): { displayName: string } | null {
  const t = text.trim();
  if (!t) return null;

  const trigger = /(?:注册账号|创建账号|开户|我要注册)/;
  if (!trigger.test(t)) return null;

  const nameLabel = t.match(/(?:名称|昵称|名字)\s*[：:]\s*([^\n]+)/);
  if (nameLabel?.[1]) {
    const displayName = nameLabel[1].trim();
    if (displayName) return { displayName };
  }

  const afterKeyword = t.replace(/^[\s\S]*?(?:注册账号|创建账号|开户|我要注册)\s*/u, "").trim();
  if (afterKeyword && !/^(名称|昵称|名字)\s*[：:]/.test(afterKeyword)) {
    const oneLine = afterKeyword.split(/\n/)[0]?.trim();
    if (oneLine) return { displayName: oneLine };
  }

  const suffix = `Agent-${Date.now().toString(36).slice(-8)}`;
  return { displayName: suffix };
}
