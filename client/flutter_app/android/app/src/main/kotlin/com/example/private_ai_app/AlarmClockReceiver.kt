package com.example.private_ai_app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 闹钟到点广播接收器 —— AlarmManager 精确闹钟触发后拉起响铃前台服务。
 * 前台服务启动失败（Android 15 后台限制等）时降级为高优先级通知。
 */
class AlarmClockReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "AlarmClockReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != "com.example.private_ai_app.alarm.FIRE") return
        val alarmId = intent.getStringExtra(AlarmClockPlugin.EXTRA_ALARM_ID) ?: return
        val label = intent.getStringExtra(AlarmClockPlugin.EXTRA_LABEL) ?: ""
        try {
            AlarmRingService.start(context, alarmId, label, null)
            Log.i(TAG, "ring service requested alarm=$alarmId")
        } catch (e: Exception) {
            Log.w(TAG, "start ring service failed, fallback notification", e)
            AlarmRingService.notifyFallback(context, alarmId, label)
        }
    }
}
