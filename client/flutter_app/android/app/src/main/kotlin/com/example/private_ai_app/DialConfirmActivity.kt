package com.example.private_ai_app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * 拨号确认全屏窗：Agent 远程发起 phone.dial 时先弹此窗，
 * 用户点「立即拨打」才真正拉起系统拨号；取消 / 超时 / 拒绝授权都回执 cancelled
 * 或降级为仅打开拨号盘（dialer_opened），由用户手动完成最后一步。
 */
class DialConfirmActivity : Activity() {

    companion object {
        const val EXTRA_NUMBER = "number"
        const val EXTRA_CONTACT_NAME = "contactName"
        const val EXTRA_REASON = "reason"
        const val EXTRA_MODE = "mode"
        const val EXTRA_TIMEOUT_SEC = "confirmTimeoutSec"
        private const val REQUEST_CALL_PHONE = 9101
    }

    private var number = ""
    private var mode = "direct"
    private var finished = false

    private val timeoutRunnable = Runnable {
        complete(ok = false, state = "cancelled", reason = "confirm_timeout")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            applyLegacyLockFlags()
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        number = intent.getStringExtra(EXTRA_NUMBER)?.trim() ?: ""
        mode = intent.getStringExtra(EXTRA_MODE) ?: "direct"
        if (number.isEmpty()) {
            complete(ok = false, state = "cancelled", error = "empty_number")
            return
        }
        setContentView(buildUi())
        val timeoutSec = intent.getIntExtra(EXTRA_TIMEOUT_SEC, 20).coerceIn(5, 25)
        window.decorView.postDelayed(timeoutRunnable, timeoutSec * 1000L)
    }

    override fun onDestroy() {
        window.decorView.removeCallbacks(timeoutRunnable)
        super.onDestroy()
    }

    /** API 27 以下没有 setShowWhenLocked，用窗口 flag 兜底 */
    @Suppress("DEPRECATION")
    private fun applyLegacyLockFlags() {
        window.addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
        )
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        complete(ok = false, state = "cancelled", reason = "user_cancel")
    }

    private fun buildUi(): View {
        val contactName = intent.getStringExtra(EXTRA_CONTACT_NAME) ?: ""
        val reason = intent.getStringExtra(EXTRA_REASON) ?: ""
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density).toInt()

        fun label(
            text: String,
            sizeSp: Float,
            bold: Boolean,
            color: Int,
            topDp: Int,
        ): TextView = TextView(this).apply {
            this.text = text
            textSize = sizeSp
            setTextColor(color)
            gravity = Gravity.CENTER
            setTypeface(typeface, if (bold) Typeface.BOLD else Typeface.NORMAL)
            setPadding(0, dp(topDp), 0, 0)
        }

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(0xFF1C1C1E.toInt())
            setPadding(dp(24), dp(24), dp(24), dp(20))
        }

        card.addView(label("Agent 请求拨打电话", 14f, false, 0xFF9E9E9E.toInt(), 0))
        card.addView(
            label(
                contactName.ifEmpty { number },
                26f,
                true,
                0xFFFFFFFF.toInt(),
                14,
            ),
        )
        if (contactName.isNotEmpty()) {
            card.addView(label(number, 16f, false, 0xFFBDBDBD.toInt(), 4))
        }
        if (reason.isNotEmpty()) {
            card.addView(label("事由：$reason", 13f, false, 0xFF9E9E9E.toInt(), 10))
        }

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(20), 0, 0)
        }
        val cancel = Button(this).apply {
            text = "取消"
            setOnClickListener {
                complete(ok = false, state = "cancelled", reason = "user_cancel")
            }
        }
        val dial = Button(this).apply {
            text = "立即拨打"
            setOnClickListener { onConfirmClicked() }
        }
        row.addView(cancel, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
            marginEnd = dp(8)
        })
        row.addView(dial, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
            marginStart = dp(8)
        })
        card.addView(
            row,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xB3000000.toInt())
            setPadding(dp(24), 0, dp(24), 0)
            addView(
                card,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ),
            )
        }
    }

    private fun onConfirmClicked() {
        val directPossible = mode == "direct" && hasCallPermission()
        if (mode == "direct" && !directPossible) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                requestPermissions(arrayOf(Manifest.permission.CALL_PHONE), REQUEST_CALL_PHONE)
                return
            }
        }
        if (directPossible) placeCall() else placeDialerOnly(permissionDenied = false)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CALL_PHONE) return
        val granted = grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (granted) {
            placeCall()
        } else {
            // 授权被拒：降级为拨号盘预填，用户手动按键
            placeDialerOnly(permissionDenied = true)
        }
    }

    private fun hasCallPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) ==
            PackageManager.PERMISSION_GRANTED

    private fun placeCall() {
        val ok = startDialIntent(Intent(Intent.ACTION_CALL, Uri.parse("tel:$number")))
        if (ok) {
            complete(ok = true, state = "dialing")
        } else {
            placeDialerOnly(permissionDenied = false)
        }
    }

    private fun placeDialerOnly(permissionDenied: Boolean) {
        val ok = startDialIntent(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$number")))
        if (ok) {
            complete(
                ok = true,
                state = "dialer_opened",
                permissionDenied = permissionDenied,
            )
        } else {
            complete(ok = false, state = "no_dialer")
        }
    }

    private fun startDialIntent(intent: Intent): Boolean = try {
        startActivity(intent)
        true
    } catch (e: Exception) {
        false
    }

    private fun complete(
        ok: Boolean,
        state: String,
        reason: String? = null,
        permissionDenied: Boolean = false,
        error: String? = null,
    ) {
        if (finished) return
        finished = true
        window.decorView.removeCallbacks(timeoutRunnable)
        PhoneBridgePlugin.completePending(
            mutableMapOf<String, Any?>(
                "ok" to ok,
                "state" to state,
                "number" to number,
            ).apply {
                if (reason != null) this["reason"] = reason
                if (permissionDenied) this["permissionDenied"] = true
                if (error != null) this["error"] = error
            },
        )
        finish()
    }
}
