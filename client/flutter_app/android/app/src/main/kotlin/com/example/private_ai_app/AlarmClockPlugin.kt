package com.example.private_ai_app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 闹钟精确调度插件（AlarmClockPlugin）—— docs/mobile-agent-reminder-alarm-design.md §6
 *
 * - scheduleNext: AlarmManager.setExactAndAllowWhileIdle 预约下一跳（App 被杀也响）；
 *   同时把调度信息写入 SharedPreferences（alarm-clock-pending.json），供开机重建。
 * - cancel: 取消预约并移除持久化条目。
 * - ringNow: 服务端兜底触发 / 测试 —— 直接拉起响铃前台服务。
 * - canScheduleExact / openExactAlarmSettings: Android 12+ 精确闹钟权限探测与引导。
 *
 * 权限缺失降级：canScheduleExact=false 时 scheduleNext 自动退化为
 * setWindow(±10min)（粗略闹钟），并返回 "degraded" 让 Dart 侧知情。
 */
class AlarmClockPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    companion object {
        private const val TAG = "AlarmClockPlugin"
        private const val CHANNEL = "private_ai_agent/alarm_clock"
        private const val PREFS = "alarm_clock_prefs"
        private const val KEY_PENDING = "pending_alarms"
        const val ACTION_SNOOZE = "com.example.private_ai_app.alarm.SNOOZE"
        const val ACTION_STOP = "com.example.private_ai_app.alarm.STOP"
        const val EXTRA_ALARM_ID = "alarmId"
        const val EXTRA_LABEL = "label"
        const val EXTRA_TTS_BASE64 = "ttsBase64"

        @Volatile
        var instance: AlarmClockPlugin? = null
            private set
    }

    private var channel: MethodChannel? = null
    private var appContext: Context? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also {
            it.setMethodCallHandler(this)
        }
        // 通知动作（贪睡/关闭）→ Dart AlarmEngine（响铃 UI 与业务推进收口在 Dart 侧）
        AlarmRingActionsReceiver.dartActionHandler = { action: String, alarmId: String ->
            channel?.invokeMethod("alarmAction", mapOf("action" to action, "alarmId" to alarmId))
        }
        instance = this
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        AlarmRingActionsReceiver.dartActionHandler = null
        if (instance === this) instance = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val ctx = appContext
        if (ctx == null) {
            result.error("NO_CONTEXT", "application context unavailable", null)
            return
        }
        when (call.method) {
            "configure" -> {
                // Dart 引擎初始化时下发网关基址：Dart 不在场时通知动作走 REST 兜底用
                val httpBase = call.argument<String>("httpBase") ?: ""
                ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString("http_base", httpBase).apply()
                result.success(true)
            }
            "scheduleNext" -> {
                val alarmId = call.argument<String>("alarmId") ?: ""
                val epochMs = call.argument<Number>("epochMs")?.toLong() ?: 0L
                val label = call.argument<String>("label") ?: ""
                if (alarmId.isEmpty() || epochMs <= 0L) {
                    result.error("BAD_ARGS", "alarmId/epochMs required", null)
                    return
                }
                result.success(scheduleExact(ctx, alarmId, epochMs, label))
            }
            "cancel" -> {
                val alarmId = call.argument<String>("alarmId") ?: ""
                cancelAlarm(ctx, alarmId)
                result.success(true)
            }
            "canScheduleExact" -> result.success(canScheduleExact(ctx))
            "openExactAlarmSettings" -> {
                openExactAlarmSettings(ctx)
                result.success(true)
            }
            "ringNow" -> {
                val alarmId = call.argument<String>("alarmId") ?: ""
                val label = call.argument<String>("label") ?: ""
                val tts = call.argument<String>("ttsBase64")
                AlarmRingService.start(ctx, alarmId, label, tts)
                result.success(true)
            }
            "stopRing" -> {
                AlarmRingService.stopAll(ctx)
                result.success(true)
            }
            else -> result.notImplemented()
        }
    }

    private fun canScheduleExact(ctx: Context): Boolean {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.canScheduleExactAlarms() else true
    }

    private fun openExactAlarmSettings(ctx: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                val intent = Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(intent)
            } catch (e: Exception) {
                Log.w(TAG, "open exact alarm settings failed", e)
            }
        }
    }

    /** 返回 "exact" | "degraded"；degraded = 权限缺失退化为 ±10min 窗口 */
    private fun scheduleExact(ctx: Context, alarmId: String, epochMs: Long, label: String): String {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = alarmPendingIntent(ctx, alarmId, epochMs, label)
        val exact = canScheduleExact(ctx)
        if (exact) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, epochMs, pi)
            } else {
                @Suppress("DEPRECATION")
                am.setExact(AlarmManager.RTC_WAKEUP, epochMs, pi)
            }
        } else {
            // 降级：±10 分钟窗口（Doze 下仍可能后移），Dart 侧据此提示用户
            am.setWindow(AlarmManager.RTC_WAKEUP, epochMs, 10 * 60_000L, pi)
        }
        persistPending(ctx, alarmId, epochMs, label)
        val whenTxt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault()).format(Date(epochMs))
        Log.i(TAG, "scheduled alarm=$alarmId mode=${if (exact) "exact" else "window10m"} at=$whenTxt")
        return if (exact) "exact" else "degraded"
    }

    fun cancelAlarm(ctx: Context, alarmId: String) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        // 取消时 PendingIntent 必须与预约时 intent-filter 匹配；epochMs/label 不影响匹配（ requestCode 用 alarmId hash）
        val pi = alarmPendingIntent(ctx, alarmId, 0L, "")
        try {
            am.cancel(pi)
        } catch (_: Exception) {
        }
        removePending(ctx, alarmId)
        Log.i(TAG, "cancelled alarm=$alarmId")
    }

    private fun alarmPendingIntent(ctx: Context, alarmId: String, epochMs: Long, label: String): PendingIntent {
        val intent = Intent(ctx, AlarmClockReceiver::class.java).apply {
            action = "com.example.private_ai_app.alarm.FIRE"
            putExtra(EXTRA_ALARM_ID, alarmId)
            putExtra(EXTRA_LABEL, label)
        }
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = flags or PendingIntent.FLAG_IMMUTABLE
        }
        return PendingIntent.getBroadcast(ctx, alarmId.hashCode(), intent, flags)
    }

    // ─── 持久化（开机重建用）：SharedPreferences 存 JSON map alarmId → {epochMs,label} ───

    private fun persistPending(ctx: Context, alarmId: String, epochMs: Long, label: String) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val map = readPending(prefs)
        map.put(alarmId, JSONObject().put("epochMs", epochMs).put("label", label))
        prefs.edit().putString(KEY_PENDING, map.toString()).apply()
    }

    private fun removePending(ctx: Context, alarmId: String) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val map = readPending(prefs)
        map.remove(alarmId)
        prefs.edit().putString(KEY_PENDING, map.toString()).apply()
    }

    fun readPending(prefs: android.content.SharedPreferences): MutableMap<String, JSONObject> {
        val out = mutableMapOf<String, JSONObject>()
        val raw = prefs.getString(KEY_PENDING, null) ?: return out
        try {
            val obj = JSONObject(raw)
            for (key in obj.keys()) out[key] = obj.getJSONObject(key)
        } catch (_: Exception) {
        }
        return out
    }

    /** 开机重建：重挂全部持久化条目（BootReceiver 调用） */
    fun rescheduleAllOnBoot(ctx: Context) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        for ((alarmId, entry) in readPending(prefs)) {
            val epochMs = entry.optLong("epochMs", 0L)
            if (epochMs <= now) {
                // 开机前已错过的跳：丢弃（手机关机期间响铃无意义；服务端兜底推送会触达）
                removePending(ctx, alarmId)
                continue
            }
            scheduleExact(ctx, alarmId, epochMs, entry.optString("label", ""))
        }
    }
}
