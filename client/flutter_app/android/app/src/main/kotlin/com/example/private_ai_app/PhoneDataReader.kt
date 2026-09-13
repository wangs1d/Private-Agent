package com.example.private_ai_app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.BatteryManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.CallLog
import android.provider.Telephony
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * 手机桥接数据读取辅助：sms_list / call_log / battery / ring 四个桥接 action 的原生实现。
 * READ_SMS / READ_CALL_LOG 是危险权限，调用前 Dart 侧必须已请求授权；
 * 未授权时返回明确的 permission_denied 错误，由模型向用户解释。
 */
object PhoneDataReader {

    data class ListResult(val ok: Boolean, val items: JSONArray, val error: String? = null)

    // ─── 短信 ───

    fun smsList(context: Context, limit: Int): ListResult {
        if (!hasPermission(context, Manifest.permission.READ_SMS)) {
            return ListResult(false, JSONArray(), "permission_denied:READ_SMS")
        }
        return try {
            val cursor = context.contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                arrayOf(
                    Telephony.Sms._ID,
                    Telephony.Sms.ADDRESS,
                    Telephony.Sms.BODY,
                    Telephony.Sms.DATE,
                    Telephony.Sms.TYPE,
                    Telephony.Sms.PERSON,
                ),
                null,
                null,
                "${Telephony.Sms.DATE} DESC",
            ) ?: return ListResult(false, JSONArray(), "query_failed:null_cursor")
            val out = JSONArray()
            cursor.use { c ->
                var n = 0
                while (c.moveToNext() && n < limit) {
                    val type = c.getInt(4)
                    // 只取收件箱(1)与已发送(2)，跳过草稿/失败项
                    if (type != 1 && type != 2) continue
                    val item = JSONObject()
                    item.put("address", c.getString(1) ?: "")
                    item.put("body", (c.getString(2) ?: "").take(500))
                    item.put("dateMs", c.getLong(3))
                    item.put("direction", if (type == 2) "outbound" else "inbound")
                    out.put(item)
                    n++
                }
            }
            ListResult(true, out)
        } catch (e: Exception) {
            ListResult(false, JSONArray(), "sms_query_error:${e.message}")
        }
    }

    // ─── 通话记录 ───

    fun callLog(context: Context, limit: Int): ListResult {
        if (!hasPermission(context, Manifest.permission.READ_CALL_LOG)) {
            return ListResult(false, JSONArray(), "permission_denied:READ_CALL_LOG")
        }
        return try {
            val cursor = context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(
                    CallLog.Calls.NUMBER,
                    CallLog.Calls.CACHED_NAME,
                    CallLog.Calls.TYPE,
                    CallLog.Calls.DATE,
                    CallLog.Calls.DURATION,
                ),
                null,
                null,
                "${CallLog.Calls.DATE} DESC",
            ) ?: return ListResult(false, JSONArray(), "query_failed:null_cursor")
            val out = JSONArray()
            cursor.use { c ->
                var n = 0
                while (c.moveToNext() && n < limit) {
                    val type = when (c.getInt(2)) {
                        CallLog.Calls.INCOMING_TYPE -> "incoming"
                        CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                        CallLog.Calls.MISSED_TYPE -> "missed"
                        else -> "other"
                    }
                    val item = JSONObject()
                    item.put("number", c.getString(0) ?: "")
                    item.put("name", c.getString(1) ?: "")
                    item.put("type", type)
                    item.put("dateMs", c.getLong(3))
                    item.put("durationSec", c.getLong(4))
                    out.put(item)
                    n++
                }
            }
            ListResult(true, out)
        } catch (e: Exception) {
            ListResult(false, JSONArray(), "calllog_query_error:${e.message}")
        }
    }

    // ─── 电量 ───

    /** @return {level:0-100, charging:bool} 或 null */
    fun battery(context: Context): JSONObject? = try {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val status = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_STATUS)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        if (level <= 0) null else JSONObject().put("level", level).put("charging", charging)
    } catch (_: Exception) {
        null
    }

    // ─── 响铃 ───

    /**
     * 响铃并振动（找手机/提醒用）：恢复最大铃声并播放默认闹钟音，
     * 同时按给定时长振动。立即返回，铃声由系统播放器自行收尾。
     */
    fun ring(context: Context, durationSec: Int, vibrate: Boolean): Boolean = try {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, max, 0)
        if (vibrate) {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as android.os.VibratorManager
                vm.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }
            val pattern = longArrayOf(0, 600, 400)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(pattern, 0)
            }
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
                { try { vibrator.cancel() } catch (_: Exception) {} },
                durationSec.coerceIn(1, 60) * 1000L,
            )
        }
        // 用默认铃声出声（ACTION_RINGER_PLAYER；老设备退回 RingtoneManager）
        val uri = android.provider.Settings.System.DEFAULT_RINGTONE_URI
        val ringtone = android.media.RingtoneManager.getRingtone(context, uri)
        if (ringtone != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                ringtone.audioAttributes = android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .build()
            }
            ringtone.play()
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
                { try { ringtone.stop() } catch (_: Exception) {} },
                durationSec.coerceIn(1, 60) * 1000L,
            )
        }
        true
    } catch (e: Exception) {
        false
    }

    private fun hasPermission(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}
