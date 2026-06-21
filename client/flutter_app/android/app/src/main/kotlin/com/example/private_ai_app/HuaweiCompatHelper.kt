package com.example.private_ai_app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * 华为 / 荣耀 / HarmonyOS 兼容性辅助类。
 * 检测设备品牌、权限状态，并提供跳转到对应系统设置页的能力。
 */
object HuaweiCompatHelper {

    private val HUAWEI_BRANDS = setOf("huawei", "honor")

    fun isHuaweiLike(): Boolean {
        val brand = Build.BRAND?.lowercase() ?: ""
        val manufacturer = Build.MANUFACTURER?.lowercase() ?: ""
        return brand in HUAWEI_BRANDS || manufacturer in HUAWEI_BRANDS
    }

    fun isHarmonyOS(): Boolean {
        return try {
            Class.forName("com.huawei.harmonyos.HarmonyOS")
            true
        } catch (_: ClassNotFoundException) {
            false
        }
    }

    fun isBatteryOptimizationWhitelisted(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    fun getCompatStatus(context: Context): Map<String, Any> {
        return mapOf(
            "ok" to true,
            "isHuaweiLike" to isHuaweiLike(),
            "isHarmonyOS" to isHarmonyOS(),
            "brand" to (Build.BRAND ?: ""),
            "manufacturer" to (Build.MANUFACTURER ?: ""),
            "model" to (Build.MODEL ?: ""),
            "batteryOptimization" to isBatteryOptimizationWhitelisted(context),
            "autostart" to false,
            "backgroundRunning" to false,
            "notificationListener" to NotificationListenerHelper.isEnabled(context),
        )
    }

    fun openSettingsByKey(context: Context, key: String) {
        val intent = when (key) {
            "battery_optimization" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
            "huawei_autostart" -> Intent().apply {
                component = android.content.ComponentName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"
                )
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            "huawei_background" -> Intent().apply {
                component = android.content.ComponentName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.optimize.process.ProtectActivity"
                )
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            "notification_listener" -> Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            "camera" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
            "location" -> Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            "sms" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
            "call_log" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
            else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
        }
        try {
            context.startActivity(intent)
        } catch (_: Exception) {
            // 兜底：跳转到应用详情
            val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(fallback)
        }
    }
}
