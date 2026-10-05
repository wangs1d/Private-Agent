# Anonymize captured call-window screenshots: erase the identity band
# (avatar disc + halo, caller name, subtitle, status label) by re-filling
# those rows with the card's own gradient color sampled at a clean column.
#
# The card background is a vertical-only gradient, horizontally uniform
# (call_visuals.h DrawGlassBase), so a per-row fill sampled at x=25 is
# seamless. Band bounds come from the C++ layout constants:
#   incoming:  avatar cy=122 r=38 halo<=53, name 172..198, sub 202..220,
#              status 226..244, divider 256        -> erase y 64..248
#   outgoing:  avatar cy=112 r=38 (no halo), name 162..188, sub 192..210,
#              divider 232                          -> erase y 70..216
#   connected: avatar cy=122 r=38 halo<=55, name 172..198,
#              waveform/timer row 202..220 (KEPT)   -> erase y 64..201
# Outputs: *_clean.png next to the originals.
# NOTE: keep this file pure ASCII (PowerShell 5.1 reads no-BOM files as GBK).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$dir = 'D:\ws-project\Private-Agent\.tmp_shot\pai_call_e2e'

function Erase-Band {
  param(
    [string] $InPng,
    [string] $OutPng,
    [int] $Y1,
    [int] $Y2,
    [int] $X1 = 24,
    [int] $X2 = 276,
    [int] $SampleX = 25
  )
  $bmp = New-Object System.Drawing.Bitmap("$dir\$InPng")
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
  for ($y = $Y1; $y -le $Y2; $y++) {
    $c = $bmp.GetPixel($SampleX, $y)
    $brush.Color = $c
    $g.FillRectangle($brush, $X1, $y, $X2 - $X1 + 1, 1)
  }
  $g.Dispose()
  $brush.Dispose()
  $bmp.Save("$dir\$OutPng", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "anonymized $InPng -> $OutPng"
}

Erase-Band 'pai_call_e2e_incoming.png'        'pai_call_e2e_incoming_clean.png'        64 248
Erase-Band 'pai_call_e2e_outgoing.png'        'pai_call_e2e_outgoing_clean.png'        70 216
Erase-Band 'pai_call_e2e_connected.png'       'pai_call_e2e_connected_clean.png'       64 201
Erase-Band 'pai_call_e2e_connected_muted.png' 'pai_call_e2e_connected_muted_clean.png' 64 201
Write-Host 'ANONYMIZED'
