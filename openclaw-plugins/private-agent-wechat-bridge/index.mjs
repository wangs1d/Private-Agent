import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { createCipheriv, randomBytes, createHash } from "node:crypto";
import os from "node:os";

const DEFAULT_CHANNEL = "openclaw-weixin";
const BRIDGE_PATH = "/integrations/wechat-claw/bridge/chat";

/** TTS 音频临时文件目录 */
const VOICE_TMP_DIR = join(process.cwd(), "data", "wechat-tts-voice");

// ---------------------------------------------------------------------------
// 微信 API 直接调用常量（绕过 OpenClaw Plugin SDK 发送语音）
// ---------------------------------------------------------------------------
const WEIXIN_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const UPLOAD_MEDIA_TYPE_VOICE = 4;       // UploadMediaType.VOICE
const MESSAGE_ITEM_TYPE_VOICE = 3;       // MessageItemType.VOICE
const VOICE_ENCODE_TYPE_MP3 = 7;         // VoiceItem.encode_type: MP3

function resolveOpenClawStateDir() {
  return (
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    join(os.homedir(), ".openclaw")
  );
}

/** 读取 openclaw-weixin 已登录账号凭据（token, baseUrl） */
function loadWeixinAccountCredentials(accountId) {
  const stateDir = resolveOpenClawStateDir();
  // 尝试标准化后的 ID (如 "xxx-im-bot")
  const accountPath = join(stateDir, "openclaw-weixin", "accounts", `${accountId}.json`);
  for (const p of [accountPath]) {
    try {
      if (existsSync(p)) {
        return JSON.parse(readFileSync(p, "utf-8"));
      }
    } catch { /* ignore */ }
  }
  return null;
}

/** 列出所有已登录的 weixin accountId */
function listWeixinAccountIds() {
  const stateDir = resolveOpenClawStateDir();
  const indexPath = join(stateDir, "openclaw-weixin", "accounts.json");
  try {
    if (existsSync(indexPath)) {
      return JSON.parse(readFileSync(indexPath, "utf-8"));
    }
  } catch { /* ignore */ }
  return [];
}

/** 读取 contextToken（从持久化文件中查找与 senderId 匹配的 token） */
function loadContextToken(accountId, senderId) {
  const stateDir = resolveOpenClawStateDir();
  const ctxPath = join(stateDir, "openclaw-weixin", "accounts", `${accountId}.context-tokens.json`);
  try {
    if (existsSync(ctxPath)) {
      const tokens = JSON.parse(readFileSync(ctxPath, "utf-8"));
      // senderId 可能是 userId@im.wechat 格式，直接匹配
      if (tokens[senderId]) return tokens[senderId];
      // 也尝试模糊匹配（key 可能是纯 userId）
      for (const [key, val] of Object.entries(tokens)) {
        if (senderId.includes(key) || key.includes(senderId)) return val;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * AES-128-ECB 加密（PKCS7 padding）
 */
function encryptAesEcb(plaintext, keyBuf) {
  const cipher = createCipheriv("aes-128-ecb", keyBuf, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** AES-128-ECB PKCS7 padding 后的密文长度 */
function aesEcbPaddedSize(plainSize) {
  return Math.ceil((plainSize + 1) / 16) * 16;
}

/** 生成随机 X-WECHAT-UIN header 值 */
function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/**
 * 直接调用微信 API 发送语音消息。
 *
 * 完整流程：读 MP3 → AES 加密 → getuploadurl(media_type=VOICE) → CDN 上传 → sendmessage(voice_item)
 *
 * 此函数绕过 OpenClaw Plugin SDK，直接使用与 openclaw-weixin 插件相同的微信 HTTP API。
 */
async function sendVoiceViaWeixinApi(params) {
  const { voiceFilePath, senderId } = params;

  // 1. 查找已登录的 weixin 账号
  const accountIds = listWeixinAccountIds();
  if (!accountIds.length) {
    throw new Error("未找到已登录的 weixin 账号，请先运行 `openclaw channels login --channel openclaw-weixin`");
  }

  // 2. 加载凭据和 contextToken
  let cred = null;
  let contextToken = null;
  let activeAccountId = null;

  for (const aid of accountIds) {
    const c = loadWeixinAccountCredentials(aid);
    if (c?.token) {
      cred = c;
      activeAccountId = aid;
      contextToken = loadContextToken(aid, senderId);
      break;
    }
  }
  if (!cred?.token) {
    throw new Error("weixin 账号未配置 token");
  }

  const baseUrl = (cred.baseUrl || WEIXIN_DEFAULT_BASE_URL).replace(/\/$/, "");
  const token = cred.token.trim();

  // 3. 读取 MP3 文件
  const plaintext = readFileSync(voiceFilePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString("hex");
  const aeskey = randomBytes(16);

  // 4. 获取上传 URL (media_type=4 VOICE)
  const uploadUrlResp = await fetch(`${baseUrl}/ilink/bot/getuploadurl`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
    },
    body: JSON.stringify({
      filekey,
      media_type: UPLOAD_MEDIA_TYPE_VOICE,
      to_user_id: senderId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
    }),
  });
  if (!uploadUrlResp.ok) {
    const errText = await uploadUrlResp.text();
    throw new Error(`getuploadurl 失败 ${uploadUrlResp.status}: ${errText}`);
  }
  const uploadData = await uploadUrlResp.json();
  const uploadFullUrl = uploadData.upload_full_url?.trim();

  if (!uploadFullUrl) {
    throw new Error(`getuploadurl 未返回上传 URL: ${JSON.stringify(uploadData)}`);
  }

  // 5. AES 加密并上传到 CDN
  const ciphertext = encryptAesEcb(plaintext, aeskey);
  const cdnResp = await fetch(uploadFullUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (cdnResp.status !== 200) {
    const errMsg = cdnResp.headers.get("x-error-message") || `status ${cdnResp.status}`;
    throw new Error(`CDN 上传失败: ${errMsg}`);
  }
  const downloadEncryptedQueryParam = cdnResp.headers.get("x-encrypted-param");
  if (!downloadEncryptedQueryParam) {
    throw new Error("CDN 响应缺少 x-encrypted-param header");
  }

  // 6. 构造 VoiceItem 并发送消息
  const clientId = `voice-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const sendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: senderId,
      client_id: clientId,
      message_type: 2, // MessageType.BOT
      message_state: 2, // MessageState.FINISH
      item_list: [{
        type: MESSAGE_ITEM_TYPE_VOICE,
        voice_item: {
          media: {
            encrypt_query_param: downloadEncryptedQueryParam,
            aes_key: aeskey.toString("base64"),
            encrypt_type: 1,
          },
          encode_type: VOICE_ENCODE_TYPE_MP3,
          playtime: Math.round(rawsize / 16000 * 1000), // 粗略估算时长(ms)，MP3 ~16kbps
        },
      }],
      context_token: contextToken || undefined,
    },
  };

  const sendResp = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
    },
    body: JSON.stringify(sendMessageReq),
  });
  if (!sendResp.ok) {
    const errText = await sendResp.text();
    throw new Error(`sendmessage 失败 ${sendResp.status}: ${errText}`);
  }

  console.log(
    `[private-agent-wechat-bridge] ✅ 语音消息发送成功 to=${senderId} size=${rawsize}B clientId=${clientId}`,
  );
  return true;
}

function pluginConfig(api, ctx) {
  const cfg =
    ctx?.pluginConfig ??
    api.config?.plugins?.entries?.["private-agent-wechat-bridge"]?.config ??
    {};
  const serverBaseUrl = (cfg.serverBaseUrl ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const bridgeToken = typeof cfg.bridgeToken === "string" ? cfg.bridgeToken.trim() : "";
  const defaultActorId =
    typeof cfg.defaultActorId === "string" && cfg.defaultActorId.trim()
      ? cfg.defaultActorId.trim()
      : "session-mvp-001";
  const channels = Array.isArray(cfg.channels) && cfg.channels.length > 0
    ? cfg.channels.map((c) => String(c))
    : [DEFAULT_CHANNEL];
  return { serverBaseUrl, bridgeToken, defaultActorId, channels };
}

function sanitizeInboundText(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  const withoutEnvelope = trimmed.replace(
    /Conversation info\s*\(untrusted metadata\):\s*```[\s\S]*?```\s*/i,
    "",
  ).trim();
  if (withoutEnvelope && withoutEnvelope !== trimmed) return withoutEnvelope;
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  if (last && !last.startsWith("{") && !last.includes("chat_id")) return last;
  return trimmed;
}

function extractDispatchText(event) {
  const candidates = [event.body, event.content]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => sanitizeInboundText(v))
    .filter(Boolean);
  if (candidates.length === 0) return "";
  return candidates.sort((a, b) => b.length - a.length)[0];
}

function channelMatches(config, event, ctx) {
  const channel = (event.channel ?? ctx.channelId ?? "").trim();
  if (!channel) return true;
  return config.channels.includes(channel);
}

/**
 * 调用 Private AI Agent 主服务，获取完整回复（含可选的 TTS 音频和提醒类型）
 */
async function callPrivateAgentBridge(config, payload) {
  const headers = { "Content-Type": "application/json" };
  if (config.bridgeToken) {
    headers.Authorization = `Bearer ${config.bridgeToken}`;
  }
  const res = await fetch(`${config.serverBaseUrl}${BRIDGE_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg =
      (body && (body.message || body.error)) ||
      `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  if (!body?.ok || typeof body.replyText !== "string") {
    throw new Error("消息桥返回格式无效");
  }
  // 返回完整响应对象（包含 ttsAudio 和 reminderType）
  return {
    replyText: body.replyText.trim(),
    ttsAudio: body.ttsAudio ?? null,
    reminderType: body.reminderType ?? null,
  };
}

/**
 * 将 base64 编码的 MP3 音频写入临时文件，返回文件路径
 */
function saveTtsAudioToTempFile(base64Data, messageId) {
  try {
    if (!existsSync(VOICE_TMP_DIR)) {
      mkdirSync(VOICE_TMP_DIR, { recursive: true });
    }
    const fileName = `tts_${messageId}_${Date.now()}.mp3`;
    const filePath = join(VOICE_TMP_DIR, fileName);
    const audioBuffer = Buffer.from(base64Data, "base64");
    writeFileSync(filePath, audioBuffer);
    return filePath;
  } catch (err) {
    console.error(`[private-agent-wechat-bridge] 写入 TTS 临时文件失败:`, err);
    return null;
  }
}

/**
 * 根据提醒类型生成微信端展示的前缀文字
 */
function formatReminderPrefix(reminderType) {
  switch (reminderType) {
    case "phone_call":
      return "\n📞 [语音来电] 您的 Agent 有紧急事项需要与您通话，请点击上方语音条收听。\n";
    case "tts_alarm":
      return "\n🔔 [语音提醒] Agent 为您播报以下内容，请点击语音条收听。\n";
    case "popup":
      return "\n⚠️ [重要提醒]\n";
    default:
      return "";
  }
}

/**
 * 尝试通过 OpenClaw API 发送语音消息。
 *
 * 策略优先级：
 *   方式 0（新增）: 直接调用微信 HTTP API（绕过 OpenClaw SDK，最可靠）
 *   方式 1        : api.sendVoice（如果 openclaw-weixin 插件支持）
 *   方式 2        : api.sendMessage 带 type=voice 参数
 *   方式 3        : dispatchReplyFromConfig 带 media 参数
 *
 * 如果所有方式都不可用，则降级为纯文本 + 提示信息。
 */
async function trySendVoiceMessage(api, event, ctx, voiceFilePath) {
  const senderId = event.senderId ?? ctx.senderId ?? ctx.conversationId;

  // 方式 0：直接调用微信 HTTP API 发送语音（绕过 OpenClaw Plugin SDK）
  try {
    const sent = await sendVoiceViaWeixinApi({ voiceFilePath, senderId });
    if (sent) return true;
  } catch (e) {
    console.warn(`[private-agent-wechat-bridge] 直接调用微信 API 发送语音失败:`, e.message);
  }

  // 方式 1：尝试使用 api.sendVoice（如果 openclaw-weixin 插件支持）
  if (typeof api.sendVoice === "function") {
    try {
      await api.sendVoice({
        path: voiceFilePath,
        conversationId: event.conversationId ?? ctx.conversationId,
        senderId: event.senderId ?? ctx.senderId,
        channelId: event.channel ?? ctx.channelId,
      });
      return true;
    } catch (e) {
      console.warn(`[private-agent-wechat-bridge] api.sendVoice 失败:`, e.message);
    }
  }

  // 方式 2：尝试使用 api.sendMessage 带 type=voice 参数
  if (typeof api.sendMessage === "function") {
    try {
      await api.sendMessage({
        type: "voice",
        path: voiceFilePath,
        conversationId: event.conversationId ?? ctx.conversationId,
      });
      return true;
    } catch (e) {
      console.warn(`[private-agent-wechat-bridge] api.sendMessage(voice) 失败:`, e.message);
    }
  }

  // 方式 3：尝试 dispatchReplyFromConfig 带 media 参数
  if (typeof api.dispatchReplyFromConfig === "function") {
    try {
      await api.dispatchReplyFromConfig({
        text: "", // 文字部分由主返回值处理
        media: [{ type: "voice", path: voiceFilePath }],
      });
      return true;
    } catch (e) {
      console.warn(`[private-agent-wechat-bridge] dispatchReplyFromConfig(voice) 失败:`, e.message);
    }
  }

  return false;
}

async function bridgeWechatTurn(api, config, { text, channel, senderId, accountId, messageId }) {
  try {
    const response = await callPrivateAgentBridge(config, {
      text,
      sessionId: config.defaultActorId,
      userId: config.defaultActorId,
      weixinSenderId: senderId || undefined,
      channel,
      accountId,
      messageId,
    });

    const { replyText, ttsAudio, reminderType } = response;

    // ---- 如果有 TTS 音频，尝试发送微信语音消息 ----
    let voiceSent = false;
    if (ttsAudio && ttsAudio.base64 && ttsAudio.format === "mp3") {
      const voicePath = saveTtsAudioToTempFile(ttsAudio.base64, messageId || "unknown");
      if (voicePath) {
        // 注意：这里需要在 before_dispatch 回调的外部上下文中发送语音
        // 由于 before_dispatch 的返回值只支持 { handled, text }，
        // 我们将语音文件路径记录下来，由后续逻辑处理
        voiceSent = !!voicePath;

        // 尝试异步发送语音（不阻塞文字回复）
        // 在 before_dispatch 回调中，event/ctx 可能携带足够的上下文来发送额外消息
        if (api._wechatBridgeLastEvent) {
          api._wechatBridgeLastEvent = { voicePath, reminderType };
        }
      }
    }

    // 构建最终回复文本
    let finalText = replyText || "（无回复内容）";

    // 如果是提醒类型且有语音，添加提示前缀
    if (reminderType && voiceSent) {
      finalText = formatReminderPrefix(reminderType) + finalText;
    }

    // 将语音路径挂载到返回对象上，供外部消费
    // （OpenClaw 框架可能不支持扩展字段，但至少我们尝试了）
    return {
      text: finalText,
      voicePath: voiceSent ? saveTtsAudioToTempFile(ttsAudio.base64, messageId || "unknown") : null,
      reminderType,
    };

  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    api.logger?.warn?.(`[private-agent-wechat-bridge] ${detail}`);
    return {
      text: `⚠️ 主服务处理失败：${detail}\n请确认 server 已启动且 WECHAT_CLAW_BRIDGE_ENABLED=1。`,
      voicePath: null,
      reminderType: null,
    };
  }
}

export default definePluginEntry({
  id: "private-agent-wechat-bridge",
  name: "Private Agent WeChat Bridge",
  description: "Route WeChat inbound to Private AI Agent AgentCore (with TTS voice support)",
  register(api) {
    const hookOpts = { priority: 200, timeoutMs: 300_000 };

    // 存储最后一次事件上下文（用于异步发送语音）
    let pendingVoicePayload = null;

    // 微信渠道走 dispatchReplyFromConfig → before_dispatch（不会跑全局 inbound_claim）
    api.on(
      "before_dispatch",
      async (event, ctx) => {
        const config = pluginConfig(api, ctx);
        const channel = (event.channel ?? ctx.channelId ?? "openclaw-weixin").trim();
        if (!channelMatches(config, event, ctx)) {
          return;
        }
        if (event.isGroup) {
          return;
        }

        const text = extractDispatchText(event);
        if (!text) {
          api.logger?.warn?.(
            `[private-agent-wechat-bridge] skip empty inbound channel=${channel}`,
          );
          return;
        }

        const msgId = event.messageId || event.msgId || `msg-${Date.now()}`;

        api.logger?.info?.(
          `[private-agent-wechat-bridge] bridge start channel=${channel} actor=${config.defaultActorId} textLen=${text.length}`,
        );

        const result = await bridgeWechatTurn(api, config, {
          text,
          channel,
          senderId: event.senderId ?? ctx.senderId ?? ctx.conversationId,
          accountId: ctx.accountId,
          messageId: msgId,
        });

        const { text: replyText, voicePath, reminderType } = result;

        // ---- 异步发送语音消息（不阻塞文字回复） ----
        if (voicePath) {
          // 使用 setTimeout 让语音发送在文字回复之后执行
          setTimeout(async () => {
            try {
              const sent = await trySendVoiceMessage(api, event, ctx, voicePath);
              if (!sent) {
                api.logger?.warn?.(
                  `[private-agent-wechat-bridge] 语音发送降级为纯文本（OpenClaw 不支持语音API），已附加文字提示`,
                );
              }
            } catch (asyncErr) {
              api.logger?.error?.(
                `[private-agent-wechat-bridge] 异步语音发送异常:`,
                asyncErr instanceof Error ? asyncErr.message : String(asyncErr),
              );
            }
          }, 500); // 延迟 500ms 确保文字先到达
        }

        api.logger?.info?.(
          `[private-agent-wechat-bridge] bridge done channel=${channel} replyLen=${replyText.length} hasVoice=${!!voicePath} type=${reminderType ?? "normal"}`,
        );

        return { handled: true, text: replyText };
      },
      hookOpts,
    );
  },
});
