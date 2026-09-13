package com.example.private_ai_app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 开机/应用更新自启：拉起常驻前台服务尽快恢复桥接与消息捕捉上报。
 * Android 15 起 BOOT_COMPLETED 不允许启动 dataSync 类型前台服务，
 * 失败会被 MessageBridgeForegroundService 内部捕获并静默降级
 * （通知监听服务由系统绑定，不依赖本 receiver）。
 */
class BootReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "BootReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        try {
            val fgs = Intent(context, MessageBridgeForegroundService::class.java)
            androidx.core.content.ContextCompat.startForegroundService(context, fgs)
            Log.i(TAG, "bridge foreground service requested on $action")
        } catch (e: Exception) {
            Log.w(TAG, "start foreground service on boot failed", e)
        }
    }
}
