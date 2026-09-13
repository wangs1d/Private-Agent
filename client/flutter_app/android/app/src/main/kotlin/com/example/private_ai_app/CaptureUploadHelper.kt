package com.example.private_ai_app

import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 拍照/录屏产物上传助手：把本地文件以 application/octet-stream
 * POST 到服务端 /phone-bridge/captures（PHONE_BRIDGE_TOKEN 鉴权），
 * 返回服务端生成的相对 url（agent 据此拉取查看）。
 */
object CaptureUploadHelper {
    private const val TAG = "CaptureUpload"

    /**
     * @param uploadBaseUrl 服务端 HTTP 基址（如 http://192.168.1.10:3000）
     * @param uploadToken   PHONE_BRIDGE_TOKEN（与桥接注册同一口令）
     */
    fun upload(
        file: File,
        uploadBaseUrl: String,
        uploadToken: String,
        actorId: String,
        ext: String,
        kind: String,
    ): Map<String, Any?> {
        if (uploadBaseUrl.isBlank() || uploadToken.isBlank()) {
            return mapOf("ok" to false, "error" to "upload_not_configured")
        }
        val connection = try {
            val base = uploadBaseUrl.trimEnd('/')
            val url = URL("$base/phone-bridge/captures?actorId=${urlEncode(actorId)}&ext=$ext&kind=${urlEncode(kind)}&token=${urlEncode(uploadToken)}")
            (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Content-Type", "application/octet-stream")
                setRequestProperty("Authorization", "Bearer $uploadToken")
                connectTimeout = 10_000
                readTimeout = 60_000
                setFixedLengthStreamingMode(file.length())
            }
        } catch (e: Exception) {
            return mapOf("ok" to false, "error" to "upload_url_error:${e.message}")
        }
        return try {
            connection.outputStream.use { out ->
                file.inputStream().use { input -> input.copyTo(out, 64 * 1024) }
            }
            val code = connection.responseCode
            val body = (if (code in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.readText().orEmpty()
            if (code in 200..299) {
                // 服务端返回 {ok:true, url:"..."}；把相对 url 拼成绝对地址
                val json = org.json.JSONObject(body.take(64 * 1024))
                val relative = json.optString("url")
                if (json.optBoolean("ok") && relative.isNotEmpty()) {
                    mapOf(
                        "ok" to true,
                        "url" to "${
                            uploadBaseUrl.trimEnd('/')
                        }$relative${if (relative.contains('?')) "&" else "?"}token=${urlEncode(uploadToken)}",
                        "file" to json.optString("file"),
                    )
                } else {
                    mapOf("ok" to false, "error" to "upload_bad_response")
                }
            } else {
                mapOf("ok" to false, "error" to "upload_http_$code")
            }
        } catch (e: Exception) {
            Log.w(TAG, "upload failed", e)
            mapOf("ok" to false, "error" to "upload_error:${e.message}")
        } finally {
            connection.disconnect()
        }
    }

    private fun urlEncode(raw: String): String =
        java.net.URLEncoder.encode(raw, "UTF-8")
}
