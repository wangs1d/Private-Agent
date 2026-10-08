# 308s self-exit reproduction probe: launch app, log process tree every 3s until exit.
$exe = "E:\ws-project\Private-Agent\windows_dist\Debug\private_ai_agent.exe"
$wd  = "E:\ws-project\Private-Agent\windows_dist\Debug"
$log = "E:\ws-project\Private-Agent\.scratch\exit-probe.log"
Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] probe start"
$t0 = Get-Date
$p = Start-Process -FilePath $exe -WorkingDirectory $wd -PassThru
Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] launched pid=$($p.Id)"
while (-not $p.HasExited) {
  Start-Sleep -Seconds 3
  # snapshot: app itself + its direct children (any name)
  $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" -ErrorAction SilentlyContinue |
    ForEach-Object { "$($_.Name):$($_.ProcessId)" }
  $alive = if ($p.HasExited) { "EXITED" } else { "alive" }
  Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] app=$($p.Id) $alive kids=[$($kids -join ', ')]"
}
$code = $p.ExitCode
$dur = [math]::Round(((Get-Date) - $t0).TotalSeconds)
Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] APP EXIT pid=$($p.Id) code=$code uptime=${dur}s"
