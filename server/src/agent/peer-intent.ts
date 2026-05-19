/**
 * 解析「发给 / 通知 / 转发」或「目标: / 内容:」形式的中继指令。
 */
export function parsePeerIntent(
  text: string,
): { targetSessionId: string; body: string; subject?: string } | null {
  const t = text.trim();
  if (!t) return null;

  const subjectLine = t.match(/(?:^|\n)\s*主题\s*[：:]\s*([^\n]+)/);
  const subject = subjectLine?.[1]?.trim();

  const targetLabel = t.match(/(?:^|\n)\s*目标\s*[：:]\s*(\S+)/);
  const contentLabel = t.match(/内容\s*[：:]\s*([\s\S]+)/);
  if (targetLabel && contentLabel) {
    let body = contentLabel[1].trim();
    body = body.replace(/(?:^|\n)\s*主题\s*[：:][^\n]+/g, "").trim();
    if (body) {
      return {
        targetSessionId: targetLabel[1].trim(),
        body,
        subject: subject || undefined,
      };
    }
  }

  const keyword = t.match(/(?:发给|转发给|转发|通知)\s+(\S+)\s+([\s\S]+)/);
  if (keyword) {
    return {
      targetSessionId: keyword[1].trim(),
      body: keyword[2].trim(),
      subject: subject || undefined,
    };
  }

  return null;
}
