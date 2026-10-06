# 灵动岛「提醒 attention 小形态」连拍驱动（2026-10-05 提醒改小胶囊档验收）：
# 等 dynamic_island_stage_e2e.dart 写 attention_ready.flag 后，对岛窗口
# （TOPMOST 分层窗，CopyFromScreen 不被遮挡）按 400ms 连拍 ~17s，
# 覆盖 待机原态 → 提醒小胶囊（脉冲环+文字，108~230 档）→ 缩回 全程。
#
# 前置：应用以 --dart-define=PAI_ISLAND_E2E=true 构建、voice 走查已过或跳过
#（attention 段在 voice 走查之后，需等 voice_ready 连拍跑完或直接等 flag）。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PaiIslandAttn {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[PaiIslandAttn]::SetProcessDPIAware() | Out-Null

$out = Join-Path $env:TEMP 'pai_island_attention'
Remove-Item "$out\*.png" -ErrorAction SilentlyContinue
Remove-Item "$out\attention_ready.flag" -ErrorAction SilentlyContinue
Remove-Item "$out\attention_done.flag" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out | Out-Null

$stageDir = Join-Path $env:TEMP 'pai_island_stage'

# ── 找岛窗口 ──
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 100 -and $hwnd -eq [IntPtr]::Zero; $i++) {
  $hwnd = [PaiIslandAttn]::FindWindowW('PAI_DynamicIsland_Window', $null)
  Start-Sleep -Milliseconds 300
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Error 'PAI_DynamicIsland_Window not found'; exit 1 }
Write-Host "island hwnd: $hwnd"

# ── 等 attention_ready.flag（stage e2e 写在 voice 走查后；上限 6 分钟）──
$deadline = (Get-Date).AddMinutes(6)
while ((Get-Date) -lt $deadline -and -not (Test-Path (Join-Path $stageDir 'attention_ready.flag'))) {
  Start-Sleep -Milliseconds 500
}
if (-not (Test-Path (Join-Path $stageDir 'attention_ready.flag'))) {
  Write-Error 'attention_ready.flag timeout'; exit 1
}

# ── 连拍：400ms × 42 帧 ≈ 17s（覆盖 ready 后 2s 待机 + 9s 提醒全程 + 余量）──
for ($f = 0; $f -lt 42; $f++) {
  $r = New-Object PaiIslandAttn+RECT
  [PaiIslandAttn]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -gt 0 -and $h -gt 0) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()
    $bmp.Save((Join-Path $out ("frame_{0:d2}.png" -f $f)), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }
  Start-Sleep -Milliseconds 400
}
Write-Host "captured to $out"
