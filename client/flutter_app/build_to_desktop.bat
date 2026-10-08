@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_apk.ps1" %*
echo.
echo ---- press any key to close ----
pause >nul
