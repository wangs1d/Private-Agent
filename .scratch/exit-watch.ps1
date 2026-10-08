# 退出码陷阱：拉起 App，死时记录退出码，自动重启（最多 15 轮，连续快速死 3 次即停）
$exe = "E:\ws-project\Private-Agent\windows_dist\Debug\private_ai_agent.exe"
$wd  = "E:\ws-project\Private-Agent\windows_dist\Debug"
$log = "E:\ws-project\Private-Agent\.scratch\exit-watch.log"
Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] watcher start"
$fastDeaths = 0
for ($i = 1; $i -le 15; $i++) {
  $t0 = Get-Date
  $p = Start-Process -FilePath $exe -WorkingDirectory $wd -PassThru
  Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] round=$i launched pid=$($p.Id)"
  $p.WaitForExit()
  $code = $p.ExitCode
  $dur = [math]::Round(((Get-Date) - $t0).TotalSeconds)
  Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] round=$i EXIT pid=$($p.Id) code=$code uptime=${dur}s"
  if ($dur -lt 90) { $fastDeaths++ } else { $fastDeaths = 0 }
  if ($fastDeaths -ge 3) { Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] 3 consecutive fast deaths, watcher stops"; break }
  Start-Sleep -Seconds 2
}
Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] watcher end"
