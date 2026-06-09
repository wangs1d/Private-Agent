@echo off
chcp 65001 >nul
echo ========================================
echo   Private AI Agent - Debug Launch Script
echo ========================================
echo.

cd /d "%~dp0client\flutter_app"

echo [1/4] Checking Flutter installation...
flutter --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Flutter not found. Please install Flutter and add it to PATH.
    pause
    exit /b 1
)
echo [OK] Flutter installed

echo.
echo [2/4] Checking dependencies...
if not exist "pubspec.lock" (
    echo [INFO] Running flutter pub get...
    call flutter pub get
    if errorlevel 1 (
        echo [ERROR] Failed to get dependencies
        pause
        exit /b 1
    )
)
echo [OK] Dependencies ready

echo.
echo [3/4] Cleaning build cache (optional)...
REM Uncomment the next line if you want to clean build
REM call flutter clean && call flutter pub get

echo.
echo [4/4] Starting app in debug mode...
echo ========================================
echo.
echo If the app crashes, check the console output above for error details.
echo Common issues:
echo   - File system permissions (documents folder access)
echo   - Corrupted local storage (JSON file)
echo   - Missing native plugins (WebView2, etc.)
echo.
echo Press Ctrl+C to stop the app
echo ========================================

REM Run with verbose logging to capture more details
flutter run -d windows -v 2>&1 | findstr /i:"error exception failed crash"

echo.
echo ========================================
echo App exited. Check output above for errors.
echo ========================================
pause
