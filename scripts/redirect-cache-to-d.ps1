# ====================================================================
# Redirect C: cache to D: drive (paddle / pip / npm / temp / flutter / etc.)
# Run as Administrator.  Idempotent: safe to re-run.
# ====================================================================
$ErrorActionPreference = "Stop"

$PADDLE = "D:\paddle"
$CACHE  = "D:\cache"

function Ensure-Dir([string]$p) {
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}

function Move-Cache([string]$src, [string]$dst) {
    if (-not (Test-Path $src)) { return }
    Ensure-Dir $dst
    Write-Host "  moving: $src -> $dst"
    try {
        & robocopy $src $dst /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
        if ($LASTEXITCODE -le 7) {
            Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "rmdir", "/S", "/Q", $src) -Wait -NoNewWindow -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Host "  (warning) robocopy $src failed: $_"
    }
}

function Make-Junction([string]$link, [string]$target) {
    if (Test-Path $link) {
        $item = Get-Item $link -Force -ErrorAction SilentlyContinue
        if ($item -and $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            return  # already a junction
        }
        # not a junction, leave it (user files in there)
        return
    }
    Write-Host "  linking: $link -> $target"
    & cmd.exe /c "mklink" "/J" $link $target | Out-Null
}

Write-Host "=== [1/4] build D: directory tree ==="
@( "$PADDLE\paddlex", "$PADDLE\paddleocr", "$PADDLE\pip", "$PADDLE\hf", "$PADDLE\hf\hub", "$PADDLE\tmp", "$PADDLE\pub" ) | ForEach-Object { Ensure-Dir $_ }
@( "$CACHE\npm", "$CACHE\nuget", "$CACHE\temp", "$CACHE\flutter", "$CACHE\vscode", "$CACHE\gradle" ) | ForEach-Object { Ensure-Dir $_ }

Write-Host "=== [2/4] move existing C: caches to D: ==="
Move-Cache "C:\Users\Administrator\.paddlex"        "$PADDLE\paddlex"
Move-Cache "C:\Users\Administrator\.paddleocr"      "$PADDLE\paddleocr"
Move-Cache "C:\Users\Administrator\AppData\Local\pip" "$PADDLE\pip"
Move-Cache "C:\Users\Administrator\.nuget"          "$CACHE\nuget"
Move-Cache "C:\Users\Administrator\AppData\Local\npm-cache" "$CACHE\npm"
Move-Cache "C:\Users\Administrator\AppData\Local\Temp" "$CACHE\temp"
Move-Cache "C:\Users\Administrator\.flutter"        "$CACHE\flutter"
Move-Cache "C:\Users\Administrator\flutter"         "$CACHE\flutter"
Move-Cache "C:\Users\Administrator\.vscode"         "$CACHE\vscode"
Move-Cache "C:\Users\Administrator\.gradle"         "$CACHE\gradle"

Write-Host "=== [3/4] make junctions (C: -> D:) ==="
Make-Junction "C:\Users\Administrator\.paddlex"        "$PADDLE\paddlex"
Make-Junction "C:\Users\Administrator\.paddleocr"      "$PADDLE\paddleocr"
Make-Junction "C:\Users\Administrator\AppData\Local\pip" "$PADDLE\pip"
Make-Junction "C:\Users\Administrator\.nuget"          "$CACHE\nuget"
Make-Junction "C:\Users\Administrator\AppData\Local\npm-cache" "$CACHE\npm"
Make-Junction "C:\Users\Administrator\AppData\Local\Temp" "$CACHE\temp"
Make-Junction "C:\Users\Administrator\.flutter"        "$CACHE\flutter"
Make-Junction "C:\Users\Administrator\flutter"         "$CACHE\flutter"
Make-Junction "C:\Users\Administrator\.vscode"         "$CACHE\vscode"
Make-Junction "C:\Users\Administrator\.gradle"         "$CACHE\gradle"
Ensure-Dir "C:\Users\Administrator\.cache"
Make-Junction "C:\Users\Administrator\.cache\huggingface" "$PADDLE\hf"

Write-Host "=== [4/4] write user env vars (D: paths) ==="
[Environment]::SetEnvironmentVariable("PIP_CACHE_DIR",         "$PADDLE\pip",       "User")
[Environment]::SetEnvironmentVariable("PADDLE_OCR_MODEL_DIR",  "$PADDLE\paddleocr", "User")
[Environment]::SetEnvironmentVariable("PPOCR_HOME",            "$PADDLE\paddleocr", "User")
[Environment]::SetEnvironmentVariable("PADDLE_PDX_CACHE_HOME", "$PADDLE\paddlex",  "User")
[Environment]::SetEnvironmentVariable("PADDLE_TMP_DIR",        "$PADDLE\tmp",       "User")
[Environment]::SetEnvironmentVariable("HF_HOME",               "$PADDLE\hf",        "User")
[Environment]::SetEnvironmentVariable("HUGGINGFACE_HUB_CACHE", "$PADDLE\hf\hub",   "User")
[Environment]::SetEnvironmentVariable("TEMP",                  "$PADDLE\tmp",       "User")
[Environment]::SetEnvironmentVariable("TMP",                   "$PADDLE\tmp",       "User")
[Environment]::SetEnvironmentVariable("TMPDIR",                "$PADDLE\tmp",       "User")
[Environment]::SetEnvironmentVariable("NPM_CONFIG_CACHE",      "$CACHE\npm",        "User")
[Environment]::SetEnvironmentVariable("NUGET_PACKAGES",        "$CACHE\nuget",      "User")
[Environment]::SetEnvironmentVariable("PUB_CACHE",             "$PADDLE\pub",       "User")
[Environment]::SetEnvironmentVariable("PYTHONDONTWRITEBYTECODE","1",                "User")

Write-Host ""
Write-Host "=== D: contents ==="
Get-ChildItem $PADDLE -Force | Select-Object Name
Write-Host "---"
Get-ChildItem $CACHE  -Force | Select-Object Name
Write-Host ""
Write-Host "Done.  Re-login / reboot for new env vars to take effect for all processes."
