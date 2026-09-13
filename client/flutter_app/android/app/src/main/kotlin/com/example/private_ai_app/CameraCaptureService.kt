package com.example.private_ai_app

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume

/**
 * 远程拍照服务（phone.camera_capture）：以 camera 类型前台服务保住后台相机权限，
 * CameraX 绑定 ImageCapture 拍一张 → 经 CaptureUploadHelper 上传 →
 * PhoneBridgePlugin.completeCapturePending 回执 Dart → 服务端 phone.bridge.result。
 *
 * 结果约定：{ok, url?, error?, state}；state ∈ captured|failed|cancelled。
 */
class CameraCaptureService : Service(), LifecycleOwner {

    companion object {
        private const val TAG = "CameraCapture"
        private const val CHANNEL_ID = "phone_capture"
        private const val NOTIFICATION_ID = 3409
        const val EXTRA_CAMERA = "camera"
        const val EXTRA_UPLOAD_BASE_URL = "uploadBaseUrl"
        const val EXTRA_UPLOAD_TOKEN = "uploadToken"
        const val EXTRA_ACTOR_ID = "actorId"
    }

    private val registry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = registry

    private val mainHandler = Handler(Looper.getMainLooper())

    private var uploadBaseUrl = ""
    private var uploadToken = ""
    private var actorId = ""
    private var lensFacing: Int = CameraSelector.LENS_FACING_BACK

    override fun onCreate() {
        super.onCreate()
        registry.currentState = Lifecycle.State.CREATED
        startForegroundCompat()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            complete(ok = false, state = "cancelled", error = "empty_intent")
            return START_NOT_STICKY
        }
        registry.currentState = Lifecycle.State.RESUMED
        uploadBaseUrl = intent.getStringExtra(EXTRA_UPLOAD_BASE_URL) ?: ""
        uploadToken = intent.getStringExtra(EXTRA_UPLOAD_TOKEN) ?: ""
        actorId = intent.getStringExtra(EXTRA_ACTOR_ID) ?: ""
        lensFacing =
            if (intent.getStringExtra(EXTRA_CAMERA) == "front") CameraSelector.LENS_FACING_FRONT
            else CameraSelector.LENS_FACING_BACK
        takePhoto()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?) = null

    override fun onDestroy() {
        registry.currentState = Lifecycle.State.DESTROYED
        super.onDestroy()
    }

    @SuppressLint("MissingPermission")
    private fun takePhoto() {
        lifecycleScope.launch {
            val uploadInput: File? = try {
                val provider = withContext(Dispatchers.Main) {
                    ProcessCameraProvider.getInstance(this@CameraCaptureService).get()
                }
                val file = File(cacheDir, "capture_${System.currentTimeMillis()}.jpg")
                val imageCapture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .build()
                val selector = CameraSelector.Builder().requireLensFacing(lensFacing).build()
                suspendCancellableCoroutine { cont ->
                    try {
                        provider.unbindAll()
                        provider.bindToLifecycle(
                            this@CameraCaptureService,
                            selector,
                            imageCapture,
                        )
                        val options = ImageCapture.OutputFileOptions.Builder(file).build()
                        imageCapture.takePicture(
                            options,
                            androidx.core.content.ContextCompat.getMainExecutor(this@CameraCaptureService),
                            object : ImageCapture.OnImageSavedCallback {
                                override fun onImageSaved(results: ImageCapture.OutputFileResults) {
                                    if (cont.isActive) cont.resume(file)
                                }
                                override fun onError(exc: ImageCaptureException) {
                                    Log.w(TAG, "takePicture failed", exc)
                                    if (cont.isActive) cont.resume(null)
                                }
                            },
                        )
                    } catch (e: Exception) {
                        Log.w(TAG, "bind camera failed", e)
                        if (cont.isActive) cont.resume(null)
                    }
                }
                file.takeIf { it.exists() && it.length() > 0 }
            } catch (e: Exception) {
                Log.w(TAG, "camera pipeline failed", e)
                null
            }

            if (uploadInput == null) {
                complete(ok = false, state = "failed", error = "camera_capture_failed")
                return@launch
            }
            // 上传放后台线程，避免阻塞主线程
            val result = withContext(Dispatchers.IO) {
                CaptureUploadHelper.upload(
                    file = uploadInput,
                    uploadBaseUrl = uploadBaseUrl,
                    uploadToken = uploadToken,
                    actorId = actorId,
                    ext = "jpg",
                    kind = "photo",
                )
            }
            uploadInput.delete()
            if (result["ok"] == true) {
                complete(ok = true, state = "captured", url = result["url"]?.toString())
            } else {
                complete(ok = false, state = "failed", error = result["error"]?.toString())
            }
        }
    }

    private fun startForegroundCompat() {        try {
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
            builder.setContentTitle("Agent 拍摄中").setSmallIcon(android.R.drawable.ic_menu_camera).setOngoing(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                startForeground(NOTIFICATION_ID, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
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
            "kind" to "photo",
        )
        if (url != null) payload["url"] = url
        if (error != null) payload["error"] = error
        PhoneBridgePlugin.completeCapturePending(payload)
        stopSelf()
    }
}
