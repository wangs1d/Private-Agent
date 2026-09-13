package com.example.private_ai_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.util.Log
import java.io.File

/**
 * 屏幕录制服务（phone.screen_record）：MediaProjection（用户已授权）+ MediaRecorder
 * 录制指定秒数 → CaptureUploadHelper 上传 mp4 → completeCapturePending 回执。
 *
 * Android 14+ 要求 mediaProjection 类型前台服务在 getMediaProjection 之前启动。
 * 不录制音频（避免与音乐/通话抢占 audio input，也减少隐私面）。
 */
class ScreenRecordService : Service() {

    companion object {
        private const val TAG = "ScreenRecord"
        private const val CHANNEL_ID = "phone_capture"
        private const val NOTIFICATION_ID = 3410
    }

    private var projection: MediaProjection? = null
    private var recorder: MediaRecorder? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var outFile: File? = null
    private var uploadBaseUrl = ""
    private var uploadToken = ""
    private var actorId = ""

    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            complete(ok = false, state = "cancelled", error = "empty_intent")
            return START_NOT_STICKY
        }
        uploadBaseUrl = intent.getStringExtra(ScreenRecordConsentActivity.EXTRA_UPLOAD_BASE_URL) ?: ""
        uploadToken = intent.getStringExtra(ScreenRecordConsentActivity.EXTRA_UPLOAD_TOKEN) ?: ""
        actorId = intent.getStringExtra(ScreenRecordConsentActivity.EXTRA_ACTOR_ID) ?: ""
        val durationSec = intent.getIntExtra(ScreenRecordConsentActivity.EXTRA_DURATION_SEC, 15).coerceIn(5, 60)
        val resultCode = intent.getIntExtra(ScreenRecordConsentActivity.EXTRA_RESULT_CODE, -1)
        @Suppress("DEPRECATION")
        val resultData = intent.getParcelableExtra<Intent>(ScreenRecordConsentActivity.EXTRA_RESULT_DATA)
        if (resultData == null) {
            complete(ok = false, state = "cancelled", error = "missing_projection_data")
            return START_NOT_STICKY
        }

        startForegroundCompat()

        try {
            val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val mp = manager.getMediaProjection(resultCode, resultData)
            if (mp == null) {
                complete(ok = false, state = "cancelled", error = "projection_null")
                return START_NOT_STICKY
            }
            projection = mp
            mp.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    // 用户从系统面板手动停止投影
                    finalizeRecording()
                }
            }, null)

            val metrics = resources.displayMetrics
            val width = Math.min(metrics.widthPixels, 1080)
            val height = Math.min(metrics.heightPixels, 1920)
            outFile = File(cacheDir, "screen_${System.currentTimeMillis()}.mp4")

            recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(this)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }.apply {
                setVideoSource(MediaRecorder.VideoSource.SURFACE)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setOutputFile(outFile!!.absolutePath)
                setVideoEncodingBitRate(4_000_000)
                setVideoEncoder(MediaRecorder.VideoEncoder.H264)
                setVideoFrameRate(24)
                setVideoSize(width, height)
                prepare()
            }

            virtualDisplay = mp.createVirtualDisplay(
                "agent_screen_record",
                width,
                height,
                metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                recorder!!.surface,
                null,
                null,
            )
            recorder!!.start()

            android.os.Handler(mainLooper).postDelayed(
                { finalizeRecording() },
                durationSec * 1000L,
            )
        } catch (e: Exception) {
            Log.w(TAG, "record start failed", e)
            complete(ok = false, state = "failed", error = "record_start_failed:${e.message}")
        }
        return START_NOT_STICKY
    }

    private fun finalizeRecording() {
        val file = outFile
        val rec = recorder
        if (rec == null || file == null) {
            complete(ok = false, state = "cancelled", error = "nothing_recorded")
            return
        }
        try {
            rec.stop()
        } catch (e: Exception) {
            Log.w(TAG, "recorder stop failed", e)
            complete(ok = false, state = "failed", error = "record_stop_failed")
            return
        }
        recorder = null
        if (!file.exists() || file.length() == 0L) {
            complete(ok = false, state = "failed", error = "record_file_empty")
            return
        }
        val result = CaptureUploadHelper.upload(
            file = file,
            uploadBaseUrl = uploadBaseUrl,
            uploadToken = uploadToken,
            actorId = actorId,
            ext = "mp4",
            kind = "screen",
        )
        file.delete()
        if (result["ok"] == true) {
            complete(ok = true, state = "recorded", url = result["url"]?.toString())
        } else {
            complete(ok = false, state = "failed", error = result["error"]?.toString())
        }
    }
    override fun onDestroy() {
        try {
            virtualDisplay?.release()
        } catch (_: Exception) {}
        try {
            projection?.stop()
        } catch (_: Exception) {}
        try {
            recorder?.release()
        } catch (_: Exception) {}
        recorder = null
        super.onDestroy()
    }

    private fun startForegroundCompat() {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "远程拍摄", NotificationManager.IMPORTANCE_MIN),
                )
            }
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }
            builder.setContentTitle("Agent 录屏中").setSmallIcon(android.R.drawable.ic_menu_view).setOngoing(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    builder.build(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
                )
            } else {
                startForeground(NOTIFICATION_ID, builder.build())
            }
        } catch (e: Exception) {
            Log.w(TAG, "startForeground failed", e)
            stopSelf()
        }
    }

    private fun complete(ok: Boolean, state: String, url: String? = null, error: String? = null) {
        val payload = mutableMapOf<String, Any?>(
            "ok" to ok,
            "state" to state,
            "kind" to "screen",
        )
        if (url != null) payload["url"] = url
        if (error != null) payload["error"] = error
        PhoneBridgePlugin.completeCapturePending(payload)
        stopSelf()
    }
}
