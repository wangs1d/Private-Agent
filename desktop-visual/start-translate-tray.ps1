# 启动屏幕翻译托盘（独立悬浮窗 + 系统托盘 + 全局热键）
#   Ctrl+Shift+T   Live 模式：反复框选翻译，结果合并到一个悬浮窗
#   Ctrl+Shift+R   Continuous 模式：定一个区域，每 2s 自动 OCR + 翻译
#   Ctrl+Shift+C   清空悬浮窗
#   Esc            退出当前模式
#   翻译：默认 auto (LLM → MyMemory 免 key 公网 API)
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Hotkey = if ($env:TRANSLATE_HOTKEY) { $env:TRANSLATE_HOTKEY.Trim() } else { "Ctrl+Shift+T" }
$ContHotkey = if ($env:TRANSLATE_CONTINUOUS_HOTKEY) { $env:TRANSLATE_CONTINUOUS_HOTKEY.Trim() } else { "Ctrl+Shift+R" }
$ClearHotkey = if ($env:TRANSLATE_CLEAR_HOTKEY) { $env:TRANSLATE_CLEAR_HOTKEY.Trim() } else { "Ctrl+Shift+C" }
$TargetLang = if ($env:TRANSLATE_TARGET_LANG) { $env:TRANSLATE_TARGET_LANG.Trim() } else { "zh" }
$SourceLang = if ($env:TRANSLATE_SOURCE_LANG) { $env:TRANSLATE_SOURCE_LANG.Trim() } else { "en" }
$ContInterval = if ($env:TRANSLATE_CONTINUOUS_INTERVAL) { [double]$env:TRANSLATE_CONTINUOUS_INTERVAL.Trim() } else { 2.0 }
$BaseUrl = if ($env:PRIVATE_AI_AGENT_BASE_URL) { $env:PRIVATE_AI_AGENT_BASE_URL.Trim() } else { "http://127.0.0.1:8787" }

Write-Host "屏幕翻译托盘启动中..."
Write-Host "  Live 热键:        $Hotkey"
Write-Host "  Continuous 热键:  $ContHotkey"
Write-Host "  清空热键:         $ClearHotkey"
Write-Host "  源 → 目标:        $SourceLang → $TargetLang"
Write-Host "  连续刷新间隔:     ${ContInterval}s"
Write-Host "  主服务:           $BaseUrl"
Write-Host "  翻译器:           $(if ($env:TRANSLATE_PROVIDER) { $env:TRANSLATE_PROVIDER } else { 'auto (LLM → MyMemory)' })"
Write-Host "  注意：请确保 PaddleOCR 服务已在 127.0.0.1:8765 运行（start-paddle-ocr.ps1）"
Write-Host "  关闭托盘即可退出"

Set-Location $Root
python -m desktop_visual.translate_tray `
    --hotkey "$Hotkey" `
    --continuous-hotkey "$ContHotkey" `
    --clear-hotkey "$ClearHotkey" `
    --target-lang "$TargetLang" `
    --source-lang "$SourceLang" `
    --continuous-interval "$ContInterval" `
    --base-url "$BaseUrl"
