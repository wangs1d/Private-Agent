package com.example.private_ai_app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.CallLog
import android.provider.Settings
import android.provider.Telephony
import android.util.Base64
import androidx.core.content.ContextCompat
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors

/**
 * 手机桥接 MethodChannel 插件。
 *
 * 处理来自 Flutter [PhoneBridgeService] 的原生调用，覆盖电量、通知、相机、录屏、
 * 定位、响铃、短信、通话记录 8 项核心能力；同时提供华为/荣耀兼容状态查询、
 * 系统设置跳转和前台服务启停接口。
 */
class PhoneBridgePlugin : FlutterPlugin, MethodChannel.MethodCallHandler {

    private lateinit var channel: MethodChannel
    private lateinit var context: Context
    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    private var ringtone: Ringtone? = null
    private var vibrator: Vibrator? = null
    private var ringStopRunnable: Runnable? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "pai/phone_bridge")
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
        executor.shutdown()
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "battery" -> getBatteryStatus(result)
            "notifications" -> getNotifications(call, result)
            "camera_capture" -> captureCamera(call, result)
            "screen_record" -> recordScreen(call, result)
            "locate" -> getLocation(result)
            "ring" -> triggerRing(call, result)
            "sms_list" -> getSmsList(call, result)
            "call_log" -> getCallLog(call, result)
            "getCompatStatus" -> result.success(HuaweiCompatHelper.getCompatStatus(context))
            "openSettingsByKey" -> openSettingsByKey(call, result)
            "startForegroundService" -> startForegroundService(result)
            "stopForegroundService" -> stopForegroundService(result)
            else -> result.notImplemented()
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. 电量
    // ─────────────────────────────────────────────────────────────────────────
    private fun getBatteryStatus(result: MethodChannel.Result) {
        val batteryManager = context.getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
        val capacity = batteryManager.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val ifilter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val statusIntent = context.registerReceiver(null, ifilter)
        val status = statusIntent?.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1) ?: -1
        val plugged = statusIntent?.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, -1) ?: -1
        val temperature = statusIntent?.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, 0)?.div(10f) ?: 0f
        val voltage = statusIntent?.getIntExtra(android.os.BatteryManager.EXTRA_VOLTAGE, 0) ?: 0
        val health = statusIntent?.getIntExtra(android.os.BatteryManager.EXTRA_HEALTH, -1) ?: -1
        result.success(
            mapOf(
                "ok" to true,
                "level" to capacity,
                "status" to batteryStatusString(status),
                "plugged" to pluggedString(plugged),
                "temperature" to temperature,
                "voltage" to voltage,
                "health" to batteryHealthString(health),
            ),
        )
    }

    private fun batteryStatusString(status: Int): String = when (status) {
        android.os.BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
        android.os.BatteryManager.BATTERY_STATUS_DISCHARGING -> "discharging"
        android.os.BatteryManager.BATTERY_STATUS_FULL -> "full"
        android.os.BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "not_charging"
        else -> "unknown"
    }

    private fun pluggedString(plugged: Int): String = when (plugged) {
        android.os.BatteryManager.BATTERY_PLUGGED_AC -> "ac"
        android.os.BatteryManager.BATTERY_PLUGGED_USB -> "usb"
        android.os.BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
        else -> "unplugged"
    }

    private fun batteryHealthString(health: Int): String = when (health) {
        android.os.BatteryManager.BATTERY_HEALTH_GOOD -> "good"
        android.os.BatteryManager.BATTERY_HEALTH_OVERHEAT -> "overheat"
        android.os.BatteryManager.BATTERY_HEALTH_DEAD -> "dead"
        android.os.BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "over_voltage"
        android.os.BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE -> "failure"
        else -> "unknown"
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. 通知
    // ─────────────────────────────────────────────────────────────────────────
    private fun getNotifications(call: MethodCall, result: MethodChannel.Result) {
        val limit = (call.argument<Number>("limit")?.toInt() ?: 20).coerceIn(1, 100)
        val items = PhoneNotificationListenerService.getRecent(limit)
        result.success(mapOf("ok" to true, "count" to items.size, "items" to items))
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. 相机拍照
    // ─────────────────────────────────────────────────────────────────────────
    private fun captureCamera(call: MethodCall, result: MethodChannel.Result) {
        if (!hasPermission(Manifest.permission.CAMERA)) {
            result.success(mapOf("ok" to false, "error" to "CAMERA permission not granted"))
            return
        }
        val camera = call.argument<String>("camera") ?: "back"
        val lensFacing = if (camera == "front") {
            android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT
        } else {
            android.hardware.camera2.CameraCharacteristics.LENS_FACING_BACK
        }
        Camera2CaptureHelper.capture(context, lensFacing) { bytes, error ->
            mainHandler.post {
                if (bytes != null) {
                    val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                    result.success(
                        mapOf(
                            "ok" to true,
                            "mimeType" to "image/jpeg",
                            "dataUri" to "data:image/jpeg;base64,$base64",
                        ),
                    )
                } else {
                    result.success(mapOf("ok" to false, "error" to (error ?: "camera capture failed")))
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. 录屏
    // ─────────────────────────────────────────────────────────────────────────
    private fun recordScreen(call: MethodCall, result: MethodChannel.Result) {
        // Android 录屏需要用户通过 Activity 授予 MediaProjection 权限，无法在服务/插件中静默完成。
        result.success(
            mapOf(
                "ok" to false,
                "error" to "Screen recording requires user-granted MediaProjection. " +
                    "Please start recording from the device UI.",
            ),
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. 定位
    // ─────────────────────────────────────────────────────────────────────────
    private fun getLocation(result: MethodChannel.Result) {
        val fine = hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
        if (!fine && !coarse) {
            result.success(mapOf("ok" to false, "error" to "LOCATION permission not granted"))
            return
        }
        LocationHelper.getLocation(context) { data, error ->
            mainHandler.post {
                if (data != null) {
                    result.success(mapOf("ok" to true) + data)
                } else {
                    result.success(mapOf("ok" to false, "error" to (error ?: "location failed")))
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. 响铃
    // ─────────────────────────────────────────────────────────────────────────
    private fun triggerRing(call: MethodCall, result: MethodChannel.Result) {
        val reason = call.argument<String>("reason") ?: ""
        val durationSec = (call.argument<Number>("durationSec")?.toInt() ?: 15).coerceIn(1, 60)
        val volume = (call.argument<Number>("volume")?.toInt() ?: 100).coerceIn(0, 100)
        val vibrate = call.argument<Boolean>("vibrate") ?: true

        stopRinging()

        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val stream = AudioManager.STREAM_ALARM
        val originalVolume = audioManager.getStreamVolume(stream)
        val maxVolume = audioManager.getStreamMaxVolume(stream)
        if (maxVolume > 0) {
            val target = (volume / 100.0 * maxVolume).toInt()
            audioManager.setStreamVolume(stream, target.coerceIn(0, maxVolume), 0)
        }

        val uri: Uri = RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_RINGTONE)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            ?: Settings.System.DEFAULT_NOTIFICATION_URI

        ringtone = RingtoneManager.getRingtone(context, uri)?.apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                isLooping = true
            }
            audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            play()
        }

        vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator?
        if (vibrate && vibrator?.hasVibrator() == true) {
            val pattern = longArrayOf(0, 800, 600)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(pattern, 0)
            }
        }

        ringStopRunnable = Runnable {
            stopRinging()
            audioManager.setStreamVolume(stream, originalVolume, 0)
        }.also { mainHandler.postDelayed(it, durationSec * 1000L) }

        result.success(mapOf("ok" to true, "reason" to reason, "durationSec" to durationSec))
    }

    private fun stopRinging() {
        ringStopRunnable?.let { mainHandler.removeCallbacks(it) }
        ringStopRunnable = null
        try { ringtone?.stop() } catch (_: Exception) {}
        ringtone = null
        try { vibrator?.cancel() } catch (_: Exception) {}
        vibrator = null
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. 短信
    // ─────────────────────────────────────────────────────────────────────────
    private fun getSmsList(call: MethodCall, result: MethodChannel.Result) {
        if (!hasPermission(Manifest.permission.READ_SMS)) {
            result.success(mapOf("ok" to false, "error" to "READ_SMS permission not granted"))
            return
        }
        executor.execute {
            val limit = (call.argument<Number>("limit")?.toInt() ?: 20).coerceIn(1, 200)
            val items = mutableListOf<Map<String, Any?>>()
            val projection = arrayOf(
                Telephony.Sms._ID,
                Telephony.Sms.ADDRESS,
                Telephony.Sms.BODY,
                Telephony.Sms.DATE,
                Telephony.Sms.READ,
                Telephony.Sms.TYPE,
            )
            context.contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                projection,
                null,
                null,
                "${Telephony.Sms.DATE} DESC LIMIT $limit",
            )?.use { cursor ->
                val idxId = cursor.getColumnIndex(Telephony.Sms._ID)
                val idxAddress = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
                val idxBody = cursor.getColumnIndex(Telephony.Sms.BODY)
                val idxDate = cursor.getColumnIndex(Telephony.Sms.DATE)
                val idxRead = cursor.getColumnIndex(Telephony.Sms.READ)
                val idxType = cursor.getColumnIndex(Telephony.Sms.TYPE)
                while (cursor.moveToNext()) {
                    items.add(
                        mapOf(
                            "id" to cursor.getString(idxId),
                            "address" to cursor.getString(idxAddress),
                            "body" to cursor.getString(idxBody),
                            "date" to cursor.getLong(idxDate),
                            "read" to (cursor.getInt(idxRead) == 1),
                            "type" to cursor.getInt(idxType),
                        ),
                    )
                }
            }
            mainHandler.post { result.success(mapOf("ok" to true, "count" to items.size, "items" to items)) }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. 通话记录
    // ─────────────────────────────────────────────────────────────────────────
    private fun getCallLog(call: MethodCall, result: MethodChannel.Result) {
        if (!hasPermission(Manifest.permission.READ_CALL_LOG)) {
            result.success(mapOf("ok" to false, "error" to "READ_CALL_LOG permission not granted"))
            return
        }
        executor.execute {
            val limit = (call.argument<Number>("limit")?.toInt() ?: 20).coerceIn(1, 200)
            val items = mutableListOf<Map<String, Any?>>()
            val projection = arrayOf(
                CallLog.Calls._ID,
                CallLog.Calls.NUMBER,
                CallLog.Calls.TYPE,
                CallLog.Calls.DATE,
                CallLog.Calls.DURATION,
                CallLog.Calls.CACHED_NAME,
            )
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                projection,
                null,
                null,
                "${CallLog.Calls.DATE} DESC LIMIT $limit",
            )?.use { cursor ->
                val idxId = cursor.getColumnIndex(CallLog.Calls._ID)
                val idxNumber = cursor.getColumnIndex(CallLog.Calls.NUMBER)
                val idxType = cursor.getColumnIndex(CallLog.Calls.TYPE)
                val idxDate = cursor.getColumnIndex(CallLog.Calls.DATE)
                val idxDuration = cursor.getColumnIndex(CallLog.Calls.DURATION)
                val idxName = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME)
                while (cursor.moveToNext()) {
                    items.add(
                        mapOf(
                            "id" to cursor.getString(idxId),
                            "number" to cursor.getString(idxNumber),
                            "type" to cursor.getInt(idxType),
                            "date" to cursor.getLong(idxDate),
                            "duration" to cursor.getLong(idxDuration),
                            "name" to cursor.getString(idxName),
                        ),
                    )
                }
            }
            mainHandler.post { result.success(mapOf("ok" to true, "count" to items.size, "items" to items)) }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 兼容/设置/服务
    // ─────────────────────────────────────────────────────────────────────────
    private fun openSettingsByKey(call: MethodCall, result: MethodChannel.Result) {
        val key = call.argument<String>("key") ?: ""
        HuaweiCompatHelper.openSettingsByKey(context, key)
        result.success(mapOf("ok" to true))
    }

    private fun startForegroundService(result: MethodChannel.Result) {
        val intent = Intent(context, PhoneBridgeForegroundService::class.java)
        ContextCompat.startForegroundService(context, intent)
        result.success(mapOf("ok" to true))
    }

    private fun stopForegroundService(result: MethodChannel.Result) {
        context.stopService(Intent(context, PhoneBridgeForegroundService::class.java))
        result.success(mapOf("ok" to true))
    }

    private fun hasPermission(permission: String): Boolean {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    }
}
