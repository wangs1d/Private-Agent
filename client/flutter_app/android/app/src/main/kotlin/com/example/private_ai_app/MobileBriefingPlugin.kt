package com.example.private_ai_app

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

class MobileBriefingPlugin(
    private val activity: Activity?,
) : FlutterPlugin, MethodChannel.MethodCallHandler {

    companion object {
        private const val CHANNEL_NAME = "pai/mobile_briefing"
        private const val NOTIFICATION_CHANNEL_ID = "daily_briefing"
        private const val NOTIFICATION_ID = 3407
        private const val EXTRA_PAYLOAD = "briefing_payload"
        private var pendingLaunchPayload: String? = null
    }

    private lateinit var context: Context
    private lateinit var channel: MethodChannel

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME)
        channel.setMethodCallHandler(this)
        deliverPendingPayloadFromIntent()
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "showBriefingNotification" -> showBriefingNotification(call, result)
            "consumeLaunchPayload" -> {
                deliverPendingPayloadFromIntent()
                val payload = pendingLaunchPayload
                pendingLaunchPayload = null
                result.success(payload)
            }
            else -> result.notImplemented()
        }
    }

    private fun showBriefingNotification(call: MethodCall, result: MethodChannel.Result) {
        val title = call.argument<String>("title") ?: "每日简报"
        val message = call.argument<String>("message") ?: "点击查看今天的简报内容"
        val payload = call.argument<String>("payload") ?: ""

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            result.success(false)
            return
        }

        ensureChannel()

        val launchIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_PAYLOAD, payload)
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            NOTIFICATION_ID,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or pendingIntentMutableFlag(),
        )

        val notification = NotificationCompat.Builder(context, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        result.success(true)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "每日简报",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "每日简报提醒与直达入口"
        }
        manager.createNotificationChannel(channel)
    }

    private fun deliverPendingPayloadFromIntent() {
        val intent = activity?.intent ?: return
        val payload = intent.getStringExtra(EXTRA_PAYLOAD) ?: return
        pendingLaunchPayload = payload
        channel.invokeMethod("onBriefingTap", payload)
        intent.removeExtra(EXTRA_PAYLOAD)
    }

    private fun pendingIntentMutableFlag(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_MUTABLE
        } else {
            0
        }
    }
}
