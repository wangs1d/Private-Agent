package com.example.private_ai_app

import android.content.Context

/**
 * 静态持有 Application Context：通知监听服务/Receiver 等非 Activity 组件
 * 需要在任意时刻拿 context 用。MainActivity.attachBaseContext 时初始化。
 */
object AppContextHolder {
    @Volatile
    lateinit var app: Context
        private set

    fun init(context: Context) {
        app = context.applicationContext
    }
}
