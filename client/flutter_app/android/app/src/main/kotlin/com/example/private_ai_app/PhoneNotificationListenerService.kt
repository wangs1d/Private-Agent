package com.example.private_ai_app

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * 通知监听服务：缓存最近通知，供 `phone.notifications` 查询。
 * 需要在系统设置中开启「通知使用权」后才会生效。
 */
class PhoneNotificationListenerService : NotificationListenerService() {

    companion object {
        private const val MAX_CACHE = 100
        private val cache = ConcurrentLinkedQueue<NotificationRecord>()

        fun getRecent(limit: Int): List<Map<String, String>> {
            return cache.toList().takeLast(limit).reversed().map { it.toMap() }
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        sbn ?: return
        val record = NotificationRecord(
            packageName = sbn.packageName,
            title = sbn.notification.extras?.getString("android.title") ?: "",
            text = sbn.notification.extras?.getCharSequence("android.text")?.toString() ?: "",
            postTime = sbn.postTime,
        )
        cache.offer(record)
        while (cache.size > MAX_CACHE) {
            cache.poll()
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        // 不处理移除事件
    }
}

data class NotificationRecord(
    val packageName: String,
    val title: String,
    val text: String,
    val postTime: Long,
) {
    fun toMap(): Map<String, String> = mapOf(
        "packageName" to packageName,
        "title" to title,
        "text" to text,
        "postTime" to postTime.toString(),
    )
}
