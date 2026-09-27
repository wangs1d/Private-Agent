import assert from "node:assert/strict";
import test from "node:test";

import {
  MiniMaxRealtimeService,
  MINIMAX_REALTIME_INPUT_SAMPLE_RATE,
  MINIMAX_REALTIME_OUTPUT_SAMPLE_RATE,
  type RealtimeSocketLike,
} from "../src/services/voice-dialogue/minimax-realtime-service.js";

/** 可脚本驱动的假 socket：测试里手动触发 open/服务端事件，记录所有出站帧。 */
class FakeSocket implements RealtimeSocketLike {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onSendHook: ((msg: Record<string, unknown>) => void) | null = null;

  private openCbs: Array<() => void> = [];
  private messageCbs: Array<(data: string) => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];
  private closeCbs: Array<(code: number, reason: string) => void> = [];

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    this.onSendHook?.(msg);
  }
  close(): void {
    this.closed = true;
  }
  onOpen(cb: () => void): void {
    this.openCbs.push(cb);
  }
  onMessage(cb: (data: string) => void): void {
    this.messageCbs.push(cb);
  }
  onError(cb: (err: Error) => void): void {
    this.errorCbs.push(cb);
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCbs.push(cb);
  }

  emitOpen(): void {
    this.openCbs.forEach((cb) => cb());
  }
  emitServer(evt: Record<string, unknown>): void {
    const raw = JSON.stringify(evt);
    this.messageCbs.forEach((cb) => cb(raw));
  }
  emitError(err: Error): void {
    this.errorCbs.forEach((cb) => cb(err));
  }
}

const ENV = { MINIMAX_API_KEY: "test-key" } as unknown as NodeJS.ProcessEnv;

test("realtime：采样率常量与协议约定（输入 16k / 输出 24k）", () => {
  assert.equal(MINIMAX_REALTIME_INPUT_SAMPLE_RATE, 16000);
  assert.equal(MINIMAX_REALTIME_OUTPUT_SAMPLE_RATE, 24000);
});

test("realtime：一轮完整对话回合（session.update → append → commit → 收音收文）", async () => {
  const socket = new FakeSocket();
  const service = new MiniMaxRealtimeService(() => socket, ENV);

  socket.onSendHook = (msg) => {
    if (msg.type === "input_audio_buffer.commit") {
      queueMicrotask(() => {
        socket.emitServer({
          type: "response.audio.delta",
          delta: Buffer.from([1, 2, 3]).toString("base64"),
        });
        socket.emitServer({
          type: "response.audio.delta",
          delta: Buffer.from([4, 5]).toString("base64"),
        });
        socket.emitServer({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "请自我介绍",
        });
        socket.emitServer({ type: "response.audio_transcript.done", transcript: "你好呀，我是你的助手。" });
        socket.emitServer({ type: "response.done", response: { status: "completed" } });
      });
    }
  };

  // 300ms 的 16kHz PCM（3 个 100ms 分片）
  const pcm = Buffer.alloc(3200 * 3, 7);
  const promise = service.dialogueTurn(pcm, { voiceId: "female-shaonv", instructions: "简短" });

  // 驱动连接建立
  socket.emitOpen();
  socket.emitServer({ type: "session.created", session: { id: "sess_1", model: "abab6.5s-chat" } });

  const result = await promise;

  // 出站帧顺序：session.update → 3 次 append → commit → response.create
  const types = socket.sent.map((m) => m.type);
  assert.deepEqual(types, [
    "session.update",
    "input_audio_buffer.append",
    "input_audio_buffer.append",
    "input_audio_buffer.append",
    "input_audio_buffer.commit",
    "response.create",
  ]);
  const update = socket.sent[0];
  const session = update.session as Record<string, unknown>;
  assert.equal(session.voice, "female-shaonv");
  assert.equal(session.instructions, "简短");
  assert.equal(session.max_response_output_tokens, "1024"); // 服务端要求字符串
  const append = socket.sent[1];
  assert.ok(typeof append.audio === "string");
  assert.equal(Buffer.from(append.audio as string, "base64").length, 3200);

  assert.deepEqual([...result.audio], [1, 2, 3, 4, 5]);
  assert.equal(result.transcript, "你好呀，我是你的助手。");
  assert.equal(result.asrText, "请自我介绍");
  assert.ok(result.firstAudioMs != null && result.firstAudioMs >= 0);
  assert.ok(result.totalMs >= 0);
  assert.equal(socket.closed, true); // 回合结束主动收连接
});

test("realtime：服务端 error 事件让回合失败", async () => {
  const socket = new FakeSocket();
  const service = new MiniMaxRealtimeService(() => socket, ENV);

  socket.onSendHook = (msg) => {
    if (msg.type === "session.update") {
      queueMicrotask(() => {
        socket.emitServer({
          type: "error",
          error: { type: "server_error", code: 1000, message: "bad session" },
        });
      });
    }
  };

  const promise = service.dialogueTurn(Buffer.alloc(3200));
  socket.emitOpen();
  socket.emitServer({ type: "session.created", session: { id: "s" } });
  await assert.rejects(promise, /bad session/);
  assert.equal(socket.closed, true);
});

test("realtime：连接失败（socket error）向上抛", async () => {
  const socket = new FakeSocket();
  const service = new MiniMaxRealtimeService(() => socket, ENV);
  const promise = service.connect();
  socket.emitError(new Error("boom"));
  await assert.rejects(promise, /boom/);
});

test("realtime：未配置 key 时禁用并拒绝", async () => {
  const service = new MiniMaxRealtimeService(undefined, {} as NodeJS.ProcessEnv);
  assert.equal(service.isEnabled(), false);
  await assert.rejects(service.dialogueTurn(Buffer.alloc(3200)), /MINIMAX_API_KEY/);
});

test("realtime：默认配置读 env（音色/指令）", async () => {
  const socket = new FakeSocket();
  const service = new MiniMaxRealtimeService(() => socket, {
    MINIMAX_API_KEY: "k",
    MINIMAX_REALTIME_VOICE: "male-qn-qingse",
    MINIMAX_REALTIME_INSTRUCTIONS: "自定义人设",
  } as unknown as NodeJS.ProcessEnv);

  let settled: ((session: unknown) => void) | null = null;
  const promise = service.connect();
  promise.then((s) => settled?.(s)).catch(() => {});
  settled = () => {};

  socket.emitOpen();
  socket.emitServer({ type: "session.created", session: { id: "s" } });
  await promise;

  const update = socket.sent[0];
  const session = update.session as Record<string, unknown>;
  assert.equal(session.voice, "male-qn-qingse");
  assert.equal(session.instructions, "自定义人设");
  socket.close();
});
