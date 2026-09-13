package com.example.private_ai_app

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 录屏授权中转窗：MediaProjection 必须由前台 Activity 发起系统授权弹窗，
 * 用户同意后把 resultCode + data 转交给 [ScreenRecordService] 开始录制；
 * 拒绝/取消直接回执 cancelled。本 Activity 本身无实际 UI（透明），
 * 授权弹窗由系统绘制。
 */
class ScreenRecordConsentActivity : Activity() {

    companion object {
        private const val REQUEST_MEDIA_PROJECTION = 9301
        const val EXTRA_DURATION_SEC = "durationSec"
        const val EXTRA_UPLOAD_BASE_URL = "uploadBaseUrl"
        const val EXTRA_UPLOAD_TOKEN = "uploadToken"
        const val EXTRA_ACTOR_ID = "actorId"

        /** 传给 Service 的结果 extras key */
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
    }

    private var durationSec = 15

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        durationSec = intent.getIntExtra(EXTRA_DURATION_SEC, 15).coerceIn(5, 60)

        // 兜底：2 分钟内未完成授权（用户没理弹窗）→ 取消
        window.decorView.postDelayed(
            {
                PhoneBridgePlugin.completeCapturePending(
                    mapOf(
                        "ok" to false,
                        "state" to "cancelled",
                        "kind" to "screen",
                        "error" to "consent_timeout",
                    ),
                )
                finish()
            },
            120_000L,
        )

        setContentView(buildHintUi())
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        try {
            startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_MEDIA_PROJECTION)
        } catch (_: Exception) {
            PhoneBridgePlugin.completeCapturePending(
                mapOf(
                    "ok" to false,
                    "state" to "cancelled",
                    "kind" to "screen",
                    "error" to "projection_intent_failed",
                ),
            )
            finish()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_MEDIA_PROJECTION) return
        if (resultCode != RESULT_OK || data == null) {
            PhoneBridgePlugin.completeCapturePending(
                mapOf(
                    "ok" to false,
                    "state" to "cancelled",
                    "kind" to "screen",
                    "error" to "projection_denied",
                ),
            )
            finish()
            return
        }
        val service = Intent(this, ScreenRecordService::class.java)
            .putExtra(EXTRA_RESULT_CODE, resultCode)
            .putExtra(EXTRA_RESULT_DATA, data)
            .putExtra(EXTRA_DURATION_SEC, durationSec)
            .putExtra(EXTRA_UPLOAD_BASE_URL, intent.getStringExtra(EXTRA_UPLOAD_BASE_URL) ?: "")
            .putExtra(EXTRA_UPLOAD_TOKEN, intent.getStringExtra(EXTRA_UPLOAD_TOKEN) ?: "")
            .putExtra(EXTRA_ACTOR_ID, intent.getStringExtra(EXTRA_ACTOR_ID) ?: "")
        androidx.core.content.ContextCompat.startForegroundService(this, service)
        finish()
    }

    private fun buildHintUi(): View {
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density).toInt()

        fun label(text: String, sizeSp: Float, bold: Boolean): TextView = TextView(this).apply {
            this.text = text
            textSize = sizeSp
            gravity = Gravity.CENTER
            setTypeface(typeface, if (bold) Typeface.BOLD else Typeface.NORMAL)
            setPadding(0, dp(8), 0, 0)
        }

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(0xFF1C1C1E.toInt())
            setPadding(dp(24), dp(24), dp(24), dp(20))
        }
        card.addView(label("Agent 请求录制屏幕", 18f, true))
        card.addView(label("请在接下来的系统弹窗中授权（时长 ${durationSec} 秒，仅录制不上传音量）", 13f, false))

        val cancel = Button(this).apply {
            text = "取消"
            setOnClickListener {
                PhoneBridgePlugin.completeCapturePending(
                    mapOf("ok" to false, "state" to "cancelled", "kind" to "screen", "error" to "user_cancel"),
                )
                finish()
            }
        }
        card.addView(
            cancel,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(16)
            },
        )

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xB3000000.toInt())
            setPadding(dp(24), 0, dp(24), 0)
            addView(card, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
    }
}
