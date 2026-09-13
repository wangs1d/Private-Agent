package com.example.private_ai_app

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 捕获消息的落盘队列：Dart 侧不可达（引擎未运行/通道断开/WS 断线）时暂存，
 * Dart 启动/重连后经 MessageCapturePlugin.drainQueue 取走补报。
 *
 * JSONL 一行一条；单文件超限（约 1MB）时截断最旧的一半，防止无限膨胀。
 * 线程安全：全部走 synchronized。
 */
object CaptureQueueStore {
    private const val TAG = "CaptureQueue"
    private const val MAX_FILE_BYTES = 1L * 1024 * 1024

    private fun file(): File = File(AppContextHolder.app.getExternalFilesDir(null) ?: AppContextHolder.app.filesDir, "msg_capture_queue.jsonl")

    @Synchronized
    fun append(items: List<Map<String, Any?>>) {
        try {
            val f = file()
            if (f.length() > MAX_FILE_BYTES) truncateHalf(f)
            f.appendText(items.joinToString("\n") { JSONObject(it).toString() } + "\n")
        } catch (e: Exception) {
            Log.w(TAG, "append failed", e)
        }
    }

    /** 取走全部排队条目并清空文件（原子语义：读出即删，失败的条目由上层重新 append） */
    @Synchronized
    fun drain(): List<Map<String, Any?>> {
        val f = file()
        if (!f.exists()) return emptyList()
        return try {
            val out = mutableListOf<Map<String, Any?>>()
            f.readLines().forEach { line ->
                if (line.isBlank()) return@forEach
                try {
                    val obj = JSONObject(line)
                    val map = mutableMapOf<String, Any?>()
                    for (key in obj.keys()) map[key] = obj.opt(key)
                    out.add(map)
                } catch (_: Exception) {
                    // 单行损坏直接丢弃
                }
            }
            f.delete()
            out
        } catch (e: Exception) {
            Log.w(TAG, "drain failed", e)
            emptyList()
        }
    }

    @Synchronized
    fun size(): Int = try {
        file().readLines().count { it.isNotBlank() }
    } catch (_: Exception) {
        0
    }

    private fun truncateHalf(f: File) {
        val lines = f.readLines().filter { it.isNotBlank() }
        val keep = lines.takeLast(lines.size / 2)
        f.writeText(keep.joinToString("\n") + "\n")
    }
}
