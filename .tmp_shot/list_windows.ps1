Get-Process | Where-Object { $null -ne $_.MainWindowTitle -and $_.MainWindowTitle -ne '' } |
  Select-Object Id, ProcessName, MainWindowTitle |
  Format-Table -AutoSize | Out-String -Width 220
