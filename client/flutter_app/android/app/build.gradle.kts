plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.example.private_ai_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    // CameraX 的 ProcessCameraProvider 暴露 ListenableFuture 类型。占位包
    // listenablefuture:1.0 与 guava 33+（自带 ListenableFuture）重复类冲突
    // （checkDebugDuplicateClasses 炸），全局排除占位包，类型统一由 guava 提供。
    configurations.all {
        resolutionStrategy {
            exclude(mapOf("group" to "com.google.guava", "module" to "listenablefuture"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // flutter_local_notifications 22+ 要求开启 core library desugaring
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.example.private_ai_app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")

    // 远程拍照（camera_capture）：CameraX 后台拍照（前台服务 + camera 类型）
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    // LifecycleService：让 CameraCaptureService 持有生命周期绑定 CameraX
    implementation("androidx.lifecycle:lifecycle-service:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    // CameraX ProcessCameraProvider.getInstance 返回 ListenableFuture（由 guava 提供）
    implementation("com.google.guava:guava:33.5.0-android")
}

flutter {
    source = "../.."
}
