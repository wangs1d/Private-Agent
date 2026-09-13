package com.example.private_ai_app

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * 通知监听服务：捕捉微信/QQ/飞书/短信等入站通知 → 批量推给 Dart
 * （经 [MessageCapturePlugin] 的 pai/phone_msg_events 通道）→ WS 上报服务端消息聚合中心。
 *
 * - 包名 → 平台映射见 [platformForPackage]；非白名单包一律忽略。
 * - 常驻/无文本/自家包通知跳过；externalMessageId = 包名|会话|正文|postTime 的哈希，
 *   服务端二次判重（重复 repost 的同一条通知不会重复计数）。
 * - Dart 侧不可达（引擎未运行/通道断开）时写入 JSONL 队列文件，Dart 启动后经
 *   MessageCapturePlugin.drainQueue 取走补报。
 * - 通知使用权（notification listener access）需用户在系统设置授予，设置页有引导。
 */
class MessageCaptureListenerService : NotificationListenerService() {

    companion object {
        private const val TAG = "MsgCapture"

        /** 批量合并窗口：通知到达后最多等这么久凑一批（毫秒） */
        private const val FLUSH_DELAY_MS = 1500L
        /** 单批上限，超出立即 flush */
        private const val BATCH_MAX = 30

        /** 包名 → 聚合平台（服务端 MessageHubPlatform） */
        private val PACKAGE_PLATFORM = mapOf(
            "com.tencent.mm" to "wechat",
            "com.tencent.mobileqq" to "qq",
            "com.ss.android.lark" to "feishu",
            "com.ss.android.lark.hd" to "feishu",
            "com.alibaba.android.rimet" to "feishu", // 钉钉按飞书域归类（办公 IM）
        )
        /** 已知短信 app 包名片段：命中按 sms 归类 */
        private val SMS_PACKAGE_HINTS = listOf("mms", "messaging")

        /** Dart 侧是否在线（MessageCapturePlugin attach/detach 维护） */
        @Volatile
        var dartChannelReady: Boolean = false

        /** 最近已上报指纹（防同一条通知 repost 重复推送；容量有限的 LRU 近似） */
        private val recentKeys = object : LinkedHashMap<String, Boolean>(64, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>): Boolean =
                size > 256
        }

        private val pending = mutableListOf<Map<String, Any?>>()
        private val mainHandler = Handler(Looper.getMainLooper())
        private val flushRunnable = Runnable { flush() }

        /** 通知使用权是否已授予（设置页检测用） */
        fun isListenerEnabled(): Boolean = try {
            val enabledPackages = androidx.core.app.NotificationManagerCompat
                .getEnabledListenerPackages(AppContextHolder.app)
            enabledPackages.contains(AppContextHolder.app.packageName)
        } catch (_: Exception) {
            false
        }

        fun platformForPackage(pkg: String): String? {
            PACKAGE_PLATFORM[pkg]?.let { return it }
            if (SMS_PACKAGE_HINTS.any { pkg.contains(it) }) return "sms"
            if (pkg.contains("lark")) return "feishu"
            return null
        }

        /** 监听服务回调：入队一批捕获消息 */
        fun enqueue(items: List<Map<String, Any?>>) {
            if (items.isEmpty()) return
            synchronized(pending) {
                pending.addAll(items)
                if (pending.size >= BATCH_MAX) {
                    mainHandler.removeCallbacks(flushRunnable)
                    flushLocked()
                    return
                }
            }
            mainHandler.removeCallbacks(flushRunnable)
            mainHandler.postDelayed(flushRunnable, FLUSH_DELAY_MS)
        }

        private fun flush() {
            synchronized(pending) { flushLocked() }
        }

        private fun flushLocked() {
            if (pending.isEmpty()) return
            val batch = ArrayList(pending)
            pending.clear()
            if (dartChannelReady) {
                val delivered = MessageCapturePlugin.dispatchToDart(batch)
                if (delivered) return
            }
            // Dart 不可达或投递失败：落盘等待补报
            CaptureQueueStore.append(batch)
        }

        private fun fingerprint(pkg: String, title: String, text: String, postTime: Long): String =
            "$pkg|$title|$text|$postTime"
    }

    private val appContext by lazy { AppContextHolder.app }

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "notification listener connected")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            val pkg = sbn.packageName ?: return
            if (pkg == applicationContext.packageName) return
            val platform = platformForPackage(pkg) ?: return
            if (sbn.isOngoing) return // 音乐/下载等常驻通知

            val extras = sbn.notification?.extras ?: return

            // MessagingStyle 消息优先（微信/QQ 新版走 EXTRA_MESSAGES 的 Bundle 数组）
            var sender: String? = null
            var text: String? = null
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    @Suppress("DEPRECATION")
                    val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
                    if (messages != null && messages.isNotEmpty()) {
                        val first = messages.last()
                        val b = first as? android.os.Bundle
                        if (b != null) {
                            text = b.getCharSequence("text")?.toString()
                            sender = b.getCharSequence("sender")?.toString()
                        }
                    }
                }
            } catch (_: Exception) {
                // 反序列化失败退回通用字段
            }

            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
            if (text.isNullOrBlank()) {
                text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
                    ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())?.trim().orEmpty()
            }
            if (text.isNullOrBlank()) return
            // 「N条新消息」这类纯计数通知没有内容价值
            if (text.length < 2) return

            val key = fingerprint(pkg, title, text, sbn.postTime)
            synchronized(recentKeys) {
                if (recentKeys.containsKey(key)) return
                recentKeys[key] = true
            }

            val item = mutableMapOf<String, Any?>(
                "platform" to platform,
                "channelId" to (sender ?: title.ifEmpty { pkg }),
                "text" to text.take(500),
                "externalMessageId" to stableHash(key),
                "capturedAt" to java.time.Instant.ofEpochMilli(System.currentTimeMillis()).toString(),
                "packageName" to pkg,
            )
            if (title.isNotEmpty()) item["title"] = title.take(100)
            if (!sender.isNullOrBlank()) item["senderName"] = sender!!.take(100)
            else if (title.isNotEmpty()) item["senderName"] = title.take(100)

            enqueue(listOf(item))
        } catch (e: Exception) {
            Log.w(TAG, "onNotificationPosted failed", e)
        }
    }

    private fun stableHash(input: String): String = try {
        val md = java.security.MessageDigest.getInstance("SHA-1")
        md.digest(input.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
            .take(20)
    } catch (_: Exception) {
        input.hashCode().toUInt().toString()
    }
}
