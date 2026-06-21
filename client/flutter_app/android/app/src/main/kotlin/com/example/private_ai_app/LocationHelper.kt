package com.example.private_ai_app

import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper

/**
 * 定位辅助类：优先返回较新的最后已知位置，否则请求单次更新，20 秒超时。
 * 使用原生 LocationManager，兼容华为/荣耀/HarmonyOS（不依赖 GMS FusedLocationProvider）。
 */
object LocationHelper {

    fun getLocation(context: Context, callback: (Map<String, Any>?, String?) -> Unit) {
        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { locationManager.isProviderEnabled(it) }
        if (providers.isEmpty()) {
            callback(null, "no location provider enabled")
            return
        }

        val now = System.currentTimeMillis()
        // 优先使用 5 分钟内的最后已知位置
        for (provider in providers) {
            try {
                val last = locationManager.getLastKnownLocation(provider)
                if (last != null && now - last.time < 5 * 60 * 1000) {
                    callback(locationToMap(last), null)
                    return
                }
            } catch (_: SecurityException) {
            }
        }

        var responded = false
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                if (responded) return
                responded = true
                locationManager.removeUpdates(this)
                callback(locationToMap(location), null)
            }

            @Deprecated("Deprecated in Java")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
            override fun onProviderEnabled(provider: String) {}
            override fun onProviderDisabled(provider: String) {}
        }

        try {
            for (provider in providers) {
                locationManager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper())
            }
            Handler(Looper.getMainLooper()).postDelayed({
                if (!responded) {
                    responded = true
                    locationManager.removeUpdates(listener)
                    callback(null, "location request timeout")
                }
            }, 20000)
        } catch (e: SecurityException) {
            callback(null, "location permission error")
        }
    }

    private fun locationToMap(location: Location): Map<String, Any> {
        return mapOf(
            "lat" to location.latitude,
            "lng" to location.longitude,
            "accuracy" to location.accuracy,
            "altitude" to location.altitude,
            "provider" to (location.provider ?: ""),
            "time" to location.time,
        )
    }
}
