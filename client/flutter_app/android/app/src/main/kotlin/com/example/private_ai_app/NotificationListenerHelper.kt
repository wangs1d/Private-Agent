package com.example.private_ai_app

import android.content.ComponentName
import android.content.Context
import android.provider.Settings

/**
 * 检测通知监听服务是否已开启。
 */
object NotificationListenerHelper {

    fun isEnabled(context: Context): Boolean {
        val cn = ComponentName(context, PhoneNotificationListenerService::class.java)
        val flat = cn.flattenToString()
        val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
            ?: return false
        return enabled.contains(flat)
    }
}
