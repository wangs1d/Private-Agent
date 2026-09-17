package com.example.private_ai_app

import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * 移动端推送通道（pai/mobile_push）。
 *
 * Dart 侧 MobilePushRegistrar 启动时调 getPushToken，把厂商推送 token 上报服务端
 * （POST /api/proactivity/push/register），用于两端都离线（App 被杀）后的离线必达：
 * 服务端 JPush / Bark / webhook 三 provider 把 critical 提醒推成系统通知。
 *
 * 当前实现：尚未接入厂商推送 SDK（极光 JPush 可聚合华为/小米/OPPO/vivo 厂商通道），
 * getPushToken 如实返回 null，Dart 侧静默降级——WS 在线直推链路完全不受影响。
 * 后续接入 JPush 的步骤：
 *   1) android/app/build.gradle 加 cn.jiguang.sdk 依赖，manifest 配 JPUSH_APPKEY；
 *   2) 本类初始化时 JInterface 接入，回调里把 registration_id 缓存 SharedPreferences；
 *   3) getPushToken 返回 {"provider":"jpush","token":<registration_id>}。
 * 零 SDK 替代路径（当下即可用）：服务端配 MOBILE_PUSH_WEBHOOK_URL 接 ntfy
 * （手机装 ntfy App 订阅对应 topic），无需本插件参与即可离线必达。
 */
class MobilePushPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private var channel: MethodChannel? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME).also {
            it.setMethodCallHandler(this)
        }
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            // 未接厂商 SDK：如实告知无 token（Dart 侧静默降级，不假装注册成功）
            "getPushToken" -> result.success(null)
            else -> result.notImplemented()
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
    }

    companion object {
        private const val CHANNEL_NAME = "pai/mobile_push"
    }
}
