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
 * 目前只承载 dial：拉起 [DialConfirmActivity] 全屏确认窗，用户确认后
 * ACTION_CALL（有 CALL_PHONE 权限）/ ACTION_DIAL 拨号。结果由 Activity 调
 * [completePending] 回传 Dart，再由 Dart 层回执服务端 phone.bridge.result。
 *
 * 同一时刻只允许一个待确认拨号；确认窗异常未回执时由本插件的兜底超时
 * （confirmTimeoutSec + 2s）回包，保证永远赶在服务端 30s invoke 超时之前。
 */
class PhoneBridgePlugin : FlutterPlugin, MethodChannel.MethodCallHandler {

    companion object {
        private const val CHANNEL_NAME = "pai/phone_bridge"
        private val mainHandler = Handler(Looper.getMainLooper())

        /** 当前待回执的 MethodChannel.Result（同一时刻最多一个拨号确认） */
        private var pendingResult: MethodChannel.Result? = null
        private var pendingTimeout: Runnable? = null

        /** DialConfirmActivity / 超时回执统一入口；幂等，须在主线程调用 */
        fun completePending(result: Map<String, Any?>) {
            mainHandler.post {
                val res = pendingResult ?: return@post
                cancelPendingTimeout()
                pendingResult = null
                try {
                    res.success(result)
                } catch (_: Exception) {
                    // 引擎可能已销毁，忽略
                }
            }
        }

        private fun cancelPendingTimeout() {
            pendingTimeout?.let { mainHandler.removeCallbacks(it) }
            pendingTimeout = null
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
        completePending(
            mapOf("ok" to false, "state" to "cancelled", "error" to "engine_detached"),
        )
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "dial" -> handleDial(call, result)
            else -> result.notImplemented()
        }
    }

    private fun handleDial(call: MethodCall, result: MethodChannel.Result) {
        if (pendingResult != null) {
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

        pendingResult = result
        val timeoutRunnable = Runnable {
            completePending(
                mapOf("ok" to false, "state" to "cancelled", "reason" to "confirm_timeout"),
            )
        }
        pendingTimeout = timeoutRunnable
        mainHandler.postDelayed(timeoutRunnable, (timeoutSec + 2) * 1000L)

        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            // 后台启动受限等场景：立即回执失败，不悬挂服务端
            completePending(
                mapOf(
                    "ok" to false,
                    "state" to "cancelled",
                    "error" to "start_confirm_failed:${e.javaClass.simpleName}",
                ),
            )
        }
    }
}
