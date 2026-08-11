import "package:flutter_test/flutter_test.dart";

import "package:private_ai_agent/core/utils/assistant_text_sanitizer.dart";

void main() {
  test("strips leading timestamp frame from full text", () {
    expect(
      stripAssistantTimestampFrames("[ts:2026-08-08 19:29:02|周六|just now] 你好"),
      "你好",
    );
  });

  test("preserves spaces across streamed chunks", () {
    final AssistantTextSanitizer sanitizer = AssistantTextSanitizer();

    expect(
      sanitizer.ingest("[ts:2026-08-08 19:29:02|周六|just now]Hello"),
      "Hello",
    );
    expect(sanitizer.ingest(" world"), " world");
    expect(sanitizer.ingest("!"), "!");
  });

  test("waits for an incomplete timestamp frame before showing text", () {
    final AssistantTextSanitizer sanitizer = AssistantTextSanitizer();

    expect(sanitizer.ingest("[ts:2026-08-08"), "");
    expect(
      sanitizer.ingest(" 19:29:02|周六|just now]你好"),
      "你好",
    );
  });

  test("does not strip ordinary bracketed content", () {
    final AssistantTextSanitizer sanitizer = AssistantTextSanitizer();

    expect(sanitizer.ingest("[计划] 先检查一下"), "[计划] 先检查一下");
  });
}
