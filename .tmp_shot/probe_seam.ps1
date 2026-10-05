$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$dir = 'D:\ws-project\Private-Agent\.tmp_shot\pai_call_e2e'
foreach ($f in @('pai_call_e2e_connected_clean.png', 'pai_call_e2e_connected_muted_clean.png')) {
  $b = New-Object System.Drawing.Bitmap("$dir\$f")
  foreach ($y in @(196, 198, 200, 202, 204, 206)) {
    $line = @()
    for ($x = 106; $x -le 194; $x += 4) {
      $c = $b.GetPixel($x, $y)
      $line += ('{0}:{1:D3}' -f $x, [int](($c.R + $c.G + $c.B) / 3))
    }
    Write-Host ("{0}  y={1}:  {2}" -f $f.Replace('pai_call_e2e_', '').Replace('_clean.png', ''), $y, ($line -join ' '))
  }
  $b.Dispose()
}
