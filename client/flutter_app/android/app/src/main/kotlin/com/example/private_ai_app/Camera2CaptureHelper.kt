package com.example.private_ai_app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureFailure
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import androidx.core.content.ContextCompat

/**
 * 使用 Camera2 API 静默拍摄单张照片，返回 JPEG 字节数组。
 *
 * 不依赖 CameraX，也不弹出系统相机界面，适合在后台被 Agent 远程触发。
 */
object Camera2CaptureHelper {

    fun capture(context: Context, lensFacing: Int, callback: (ByteArray?, String?) -> Unit) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            callback(null, "CAMERA permission not granted")
            return
        }

        val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cameraId = cameraManager.cameraIdList.find { id ->
            cameraManager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) == lensFacing
        }
        if (cameraId == null) {
            callback(null, "no camera with lensFacing=$lensFacing")
            return
        }

        val thread = HandlerThread("PhoneBridgeCamera").apply { start() }
        val handler = Handler(thread.looper)
        val timeoutHandler = Handler(Looper.getMainLooper())

        lateinit var imageReader: ImageReader
        var cameraDevice: CameraDevice? = null
        var captureSession: CameraCaptureSession? = null
        var completed = false

        fun finish(bytes: ByteArray?, error: String?) {
            if (completed) return
            completed = true
            timeoutHandler.removeCallbacksAndMessages(null)
            try { captureSession?.close() } catch (_: Exception) {}
            try { cameraDevice?.close() } catch (_: Exception) {}
            try { imageReader.close() } catch (_: Exception) {}
            thread.quitSafely()
            callback(bytes, error)
        }

        // 15 秒安全超时
        timeoutHandler.postDelayed({ finish(null, "camera capture timeout") }, 15000)

        imageReader = ImageReader.newInstance(1280, 960, ImageFormat.JPEG, 2).apply {
            setOnImageAvailableListener({ reader ->
                val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                val buffer = image.planes[0].buffer
                val bytes = ByteArray(buffer.remaining())
                buffer.get(bytes)
                image.close()
                finish(bytes, null)
            }, handler)
        }

        try {
            cameraManager.openCamera(cameraId, object : CameraDevice.StateCallback() {
                override fun onOpened(device: CameraDevice) {
                    cameraDevice = device
                    val surface = imageReader.surface
                    device.createCaptureSession(
                        listOf(surface),
                        object : CameraCaptureSession.StateCallback() {
                            override fun onConfigured(session: CameraCaptureSession) {
                                captureSession = session
                                val request = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                                    addTarget(surface)
                                    set(CaptureRequest.JPEG_QUALITY, 90.toByte())
                                    set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)
                                    set(CaptureRequest.FLASH_MODE, CameraMetadata.FLASH_MODE_OFF)
                                }.build()
                                session.capture(request, object : CameraCaptureSession.CaptureCallback() {
                                    override fun onCaptureFailed(
                                        session: CameraCaptureSession,
                                        request: CaptureRequest,
                                        failure: CaptureFailure,
                                    ) {
                                        finish(null, "capture failed: ${failure.reason}")
                                    }
                                }, handler)
                            }

                            override fun onConfigureFailed(session: CameraCaptureSession) {
                                finish(null, "camera session configure failed")
                            }
                        },
                        handler,
                    )
                }

                override fun onDisconnected(device: CameraDevice) {
                    finish(null, "camera disconnected")
                }

                override fun onError(device: CameraDevice, error: Int) {
                    finish(null, "camera error $error")
                }
            }, handler)
        } catch (e: Exception) {
            finish(null, e.message ?: "camera open error")
        }
    }
}
