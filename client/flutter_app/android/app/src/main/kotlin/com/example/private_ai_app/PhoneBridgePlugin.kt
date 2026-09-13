package com.example.private_ai_app

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * 手机桥接原生通道（pai/phone_bridge）。
 *
 * 承载四类指令：
 *  - dial：拉起 [DialConfirmActivity] 全屏确认窗，用户确认后 ACTION_CALL（有 CALL_PHONE
 *    权限）/ ACTION_DIAL 拨号；结果由 Activity 调 [completeDialPending] 回传 Dart，
 *    再由 Dart 层回执服务端 phone.bridge.result。
 *  - sendSms：拉起 [SmsSendConfirmActivity] 确认窗，用户确认后 SmsManager 发出。
 *  - smsList / callLog / battery / ring：[PhoneDataReader] 直接执行并同步回包。
 *
 * 拨号与发短信各自同一时刻只允许一个待确认请求；确认窗异常未回执时由本插件的
 * 兜底超时（confirmTimeoutSec + 2s）回包，保证永远赶在服务端 30s invoke 超时之前。
 */
class PhoneBridgePlugin : FlutterPlugin, MethodChannel.MethodCallHandler {

    companion object {
        private const val CHANNEL_NAME = "pai/phone_bridge"
        private val mainHandler = Handler(Looper.getMainLooper())

        /** 当前待回执的拨号 MethodChannel.Result（同一时刻最多一个） */
        private var pendingDialResult: MethodChannel.Result? = null
        private var pendingDialTimeout: Runnable? = null

        /** 当前待回执的发短信 MethodChannel.Result（同一时刻最多一个） */
        private var pendingSmsResult: MethodChannel.Result? = null
        private var pendingSmsTimeout: Runnable? = null

        /** 当前待回执的拍照/录屏 MethodChannel.Result（同一时刻最多一个，拍照/录屏互斥） */
        private var pendingCaptureResult: MethodChannel.Result? = null

        /** CameraCaptureService / ScreenRecordService / 授权窗统一回执入口；幂等 */
        fun completeCapturePending(result: Map<String, Any?>) {
            mainHandler.post {
                val res = pendingCaptureResult ?: return@post
                pendingCaptureResult = null
                try {
                    res.success(result)
                } catch (_: Exception) {
                    // 引擎可能已销毁，忽略
                }
            }
        }

        /** DialConfirmActivity / 超时回执统一入口；幂等，须在主线程调用 */
        fun completeDialPending(result: Map<String, Any?>) {
            mainHandler.post {
                val res = pendingDialResult ?: return@post
                pendingDialTimeout?.let { mainHandler.removeCallbacks(it) }
                pendingDialTimeout = null
                pendingDialResult = null
                try {
                    res.success(result)
                } catch (_: Exception) {
                    // 引擎可能已销毁，忽略
                }
            }
        }

        /** SmsSendConfirmActivity / 超时回执统一入口；幂等，须在主线程调用 */
        fun completeSmsPending(result: Map<String, Any?>) {
            mainHandler.post {
                val res = pendingSmsResult ?: return@post
                pendingSmsTimeout?.let { mainHandler.removeCallbacks(it) }
                pendingSmsTimeout = null
                pendingSmsResult = null
                try {
                    res.success(result)
                } catch (_: Exception) {
                    // 引擎可能已销毁，忽略
                }
            }
        }
    }

    private lateinit var context: Context
    private lateinit var channel: MethodChannel

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME)
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
        completeDialPending(
            mapOf("ok" to false, "state" to "cancelled", "error" to "engine_detached"),
        )
        completeSmsPending(
            mapOf("ok" to false, "state" to "cancelled", "error" to "engine_detached"),
        )
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "dial" -> handleDial(call, result)
            "sendSms" -> handleSendSms(call, result)
            "cameraCapture" -> handleCameraCapture(call, result)
            "screenRecord" -> handleScreenRecord(call, result)
            "smsList" -> {
                val limit = (call.argument<Int>("limit") ?: 20).coerceIn(1, 100)
                val r = PhoneDataReader.smsList(context, limit)
                if (r.ok) result.success(mapOf("ok" to true, "messages" to jsonToList(r.items)))
                else result.success(mapOf("ok" to false, "error" to r.error))
            }
            "callLog" -> {
                val limit = (call.argument<Int>("limit") ?: 20).coerceIn(1, 100)
                val r = PhoneDataReader.callLog(context, limit)
                if (r.ok) result.success(mapOf("ok" to true, "calls" to jsonToList(r.items)))
                else result.success(mapOf("ok" to false, "error" to r.error))
            }
            "battery" -> {
                val info = PhoneDataReader.battery(context)
                if (info != null) {
                    result.success(
                        mapOf("ok" to true, "level" to info.optInt("level"), "charging" to info.optBoolean("charging")),
                    )
                } else {
                    result.success(mapOf("ok" to false, "error" to "battery_unavailable"))
                }
            }
            "ring" -> {
                val durationSec = (call.argument<Int>("durationSec") ?: 15).coerceIn(1, 60)
                val vibrate = call.argument<Boolean>("vibrate") ?: true
                result.success(mapOf("ok" to PhoneDataReader.ring(context, durationSec, vibrate)))
            }
            else -> result.notImplemented()
        }
    }

    private fun jsonToList(array: org.json.JSONArray): List<Any?> =
        (0 until array.length()).map { array.opt(it) }

    // ─── dial：确认后拨出 ───

    private fun handleDial(call: MethodCall, result: MethodChannel.Result) {
        if (pendingDialResult != null) {
            result.success(mapOf("ok" to false, "error" to "dial_in_progress"))
            return
        }
        val number = call.argument<String>("number")?.trim() ?: ""
        if (number.isEmpty()) {
            result.success(mapOf("ok" to false, "error" to "empty_number"))
            return
        }
        val timeoutSec = (call.argument<Int>("confirmTimeoutSec") ?: 20).coerceIn(5, 25)
        val intent = Intent(context, DialConfirmActivity::class.java).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP,
            )
            putExtra(DialConfirmActivity.EXTRA_NUMBER, number)
            putExtra(DialConfirmActivity.EXTRA_CONTACT_NAME, call.argument<String>("contactName") ?: "")
            putExtra(DialConfirmActivity.EXTRA_REASON, call.argument<String>("reason") ?: "")
            putExtra(DialConfirmActivity.EXTRA_MODE, call.argument<String>("mode") ?: "direct")
            putExtra(DialConfirmActivity.EXTRA_TIMEOUT_SEC, timeoutSec)
        }

        pendingDialResult = result
        val timeoutRunnable = Runnable {
            completeDialPending(
                mapOf("ok" to false, "state" to "cancelled", "reason" to "confirm_timeout"),
            )
        }
        pendingDialTimeout = timeoutRunnable
        mainHandler.postDelayed(timeoutRunnable, (timeoutSec + 2) * 1000L)

        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            // 后台启动受限等场景：立即回执失败，不悬挂服务端
            mainHandler.removeCallbacks(timeoutRunnable)
            pendingDialTimeout = null
            pendingDialResult = null
            result.success(
                mapOf(
                    "ok" to false,
                    "state" to "cancelled",
                    "error" to "start_confirm_failed",
                    "error_detail" to e.javaClass.simpleName,
                ),
            )
        }
    }

    // ─── sendSms：确认后发出 ───

    private fun handleSendSms(call: MethodCall, result: MethodChannel.Result) {
        if (pendingSmsResult != null) {
            result.success(mapOf("ok" to false, "error" to "sms_send_in_progress"))
            return
        }
        val number = call.argument<String>("number")?.trim() ?: ""
        val text = call.argument<String>("text")?.trim() ?: ""
        if (number.isEmpty() || text.isEmpty()) {
            result.success(mapOf("ok" to false, "error" to "empty_number_or_text"))
            return
        }
        val timeoutSec = (call.argument<Int>("confirmTimeoutSec") ?: 25).coerceIn(10, 28)
        val intent = Intent(context, SmsSendConfirmActivity::class.java).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP,
            )
            putExtra(SmsSendConfirmActivity.EXTRA_NUMBER, number)
            putExtra(SmsSendConfirmActivity.EXTRA_TEXT, text)
            putExtra(SmsSendConfirmActivity.EXTRA_CONTACT_NAME, call.argument<String>("contactName") ?: "")
            putExtra(SmsSendConfirmActivity.EXTRA_REASON, call.argument<String>("reason") ?: "")
            putExtra(SmsSendConfirmActivity.EXTRA_TIMEOUT_SEC, timeoutSec)
        }

        pendingSmsResult = result
        val timeoutRunnable = Runnable {
            completeSmsPending(
                mapOf("ok" to false, "state" to "cancelled", "reason" to "confirm_timeout"),
            )
        }
        pendingSmsTimeout = timeoutRunnable
        mainHandler.postDelayed(timeoutRunnable, (timeoutSec + 2) * 1000L)

        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            mainHandler.removeCallbacks(timeoutRunnable)
            pendingSmsTimeout = null
            pendingSmsResult = null
            result.success(
                mapOf(
                    "ok" to false,
                    "state" to "cancelled",
                    "error" to "start_confirm_failed",
                    "error_detail" to e.javaClass.simpleName,
                ),
            )
        }
    }

    // ─── camera_capture：前台服务 CameraX 拍一张并上传 ───

    private fun handleCameraCapture(call: MethodCall, result: MethodChannel.Result) {
        if (pendingCaptureResult != null) {
            result.success(mapOf("ok" to false, "error" to "capture_in_progress"))
            return
        }
        val uploadBaseUrl = call.argument<String>("uploadBaseUrl")?.trim() ?: ""
        val uploadToken = call.argument<String>("uploadToken")?.trim() ?: ""
        if (uploadBaseUrl.isEmpty() || uploadToken.isEmpty()) {
            result.success(mapOf("ok" to false, "error" to "upload_not_configured"))
            return
        }
        pendingCaptureResult = result
        val intent = Intent(context, CameraCaptureService::class.java).apply {
            putExtra(CameraCaptureService.EXTRA_CAMERA, call.argument<String>("camera") ?: "back")
            putExtra(CameraCaptureService.EXTRA_UPLOAD_BASE_URL, uploadBaseUrl)
            putExtra(CameraCaptureService.EXTRA_UPLOAD_TOKEN, uploadToken)
            putExtra(CameraCaptureService.EXTRA_ACTOR_ID, call.argument<String>("actorId") ?: "")
        }
        try {
            androidx.core.content.ContextCompat.startForegroundService(context, intent)
        } catch (e: Exception) {
            pendingCaptureResult = null
            result.success(
                mapOf(
                    "ok" to false,
                    "state" to "failed",
                    "kind" to "photo",
                    "error" to "start_capture_failed",
                    "error_detail" to e.javaClass.simpleName,
                ),
            )
        }
    }

    // ─── screen_record：授权窗 → 前台服务录制并上传 ───

    private fun handleScreenRecord(call: MethodCall, result: MethodChannel.Result) {
        if (pendingCaptureResult != null) {
            result.success(mapOf("ok" to false, "error" to "capture_in_progress"))
            return
        }
        val uploadBaseUrl = call.argument<String>("uploadBaseUrl")?.trim() ?: ""
        val uploadToken = call.argument<String>("uploadToken")?.trim() ?: ""
        if (uploadBaseUrl.isEmpty() || uploadToken.isEmpty()) {
            result.success(mapOf("ok" to false, "error" to "upload_not_configured"))
            return
        }
        pendingCaptureResult = result
        val intent = Intent(context, ScreenRecordConsentActivity::class.java).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP,
            )
            putExtra(
                ScreenRecordConsentActivity.EXTRA_DURATION_SEC,
                (call.argument<Int>("durationSec") ?: 15).coerceIn(5, 60),
            )
            putExtra(ScreenRecordConsentActivity.EXTRA_UPLOAD_BASE_URL, uploadBaseUrl)
            putExtra(ScreenRecordConsentActivity.EXTRA_UPLOAD_TOKEN, uploadToken)
            putExtra(ScreenRecordConsentActivity.EXTRA_ACTOR_ID, call.argument<String>("actorId") ?: "")
        }
        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            pendingCaptureResult = null
            result.success(
                mapOf(
                    "ok" to false,
                    "state" to "cancelled",
                    "kind" to "screen",
                    "error" to "start_consent_failed",
                    "error_detail" to e.javaClass.simpleName,
                ),
            )
        }
    }
}
