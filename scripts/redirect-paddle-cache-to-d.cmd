@echo off
REM ====================================================================
REM Redirect project-related caches and downloads from C: to D:.
REM Run as Administrator (mklink /J needs elevation).
REM Steps:
REM   1) Create D:\paddle\* and D:\cache\* directory tree
REM   2) Move existing C: data to D: via robocopy (locked files get skipped)
REM   3) Create junction for each C: path so future writes land on D:
REM   4) Write user-level env vars to point to D:
REM Re-runnable: existing junctions and target dirs are skipped.
REM ====================================================================
setlocal EnableExtensions
set PADDLE_ROOT=D:\paddle
set CACHE_ROOT=D:\cache

echo === [1/4] Create D: directory tree ===
if not exist "%PADDLE_ROOT%\paddlex"   mkdir "%PADDLE_ROOT%\paddlex"
if not exist "%PADDLE_ROOT%\paddleocr" mkdir "%PADDLE_ROOT%\paddleocr"
if not exist "%PADDLE_ROOT%\pip"       mkdir "%PADDLE_ROOT%\pip"
if not exist "%PADDLE_ROOT%\hf"        mkdir "%PADDLE_ROOT%\hf"
if not exist "%PADDLE_ROOT%\hf\hub"    mkdir "%PADDLE_ROOT%\hf\hub"
if not exist "%PADDLE_ROOT%\tmp"       mkdir "%PADDLE_ROOT%\tmp"
if not exist "%PADDLE_ROOT%\pub"       mkdir "%PADDLE_ROOT%\pub"

if not exist "%CACHE_ROOT%\npm"        mkdir "%CACHE_ROOT%\npm"
if not exist "%CACHE_ROOT%\nuget"      mkdir "%CACHE_ROOT%\nuget"
if not exist "%CACHE_ROOT%\temp"       mkdir "%CACHE_ROOT%\temp"
if not exist "%CACHE_ROOT%\flutter"    mkdir "%CACHE_ROOT%\flutter"
if not exist "%CACHE_ROOT%\vscode"     mkdir "%CACHE_ROOT%\vscode"
if not exist "%CACHE_ROOT%\gradle"     mkdir "%CACHE_ROOT%\gradle"

echo === [2/4] Move C: -> D: (skip locked files) ===

REM .paddlex
if exist "C:\Users\Administrator\.paddlex" (
    robocopy "C:\Users\Administrator\.paddlex" "%PADDLE_ROOT%\paddlex" /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 >NUL
    rmdir /S /Q "C:\Users\Administrator\.paddlex" 2>NUL
    if exist "C:\Users\Administrator\.paddlex" (echo   [skip] .paddlex delete blocked; junction below covers it) else (echo   [ok] .paddlex migrated)
)

REM .paddleocr
if exist "C:\Users\Administrator\.paddleocr" (
    robocopy "C:\Users\Administrator\.paddleocr" "%PADDLE_ROOT%\paddleocr" /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 >NUL
    rmdir /S /Q "C:\Users\Administrator\.paddleocr" 2>NUL
)

REM pip cache
if exist "C:\Users\Administrator\AppData\Local\pip" (
    robocopy "C:\Users\Administrator\AppData\Local\pip" "%PADDLE_ROOT%\pip" /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 >NUL
    rmdir /S /Q "C:\Users\Administrator\AppData\Local\pip" 2>NUL
)

REM .nuget
if exist "C:\Users\Administrator\.nuget" (
    robocopy "C:\Users\Administrator\.nuget" "%CACHE_ROOT%\nuget" /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 >NUL
    rmdir /S /Q "C:\Users\Administrator\.nuget" 2>NUL
)

REM npm-cache
if exist "C:\Users\Administrator\AppData\Local\npm-cache" (
    robocopy "C:\Users\Administrator\AppData\Local\npm-cache" "%CACHE_ROOT%\npm" /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 >NUL
    rmdir /S /Q "C:\Users\Administrator\AppData\Local\npm-cache" 2>NUL
)

REM NuGet
if exist "C:\Users\Administrator\AppData\Local\NuGet" (
    robocopy "C:\Users\Administrator\AppData\Local\NuGet" "%CACHE_ROOT%\nuget" /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 >NUL
    rmdir /S /Q "C:\Users\Administrator\AppData\Local\NuGet" 2>NUL
)

REM Temp (best effort: many processes hold files; junction still works as fallback)
if exist "C:\Users\Administrator\AppData\Local\Temp" (
    robocopy "C:\Users\Administrator\AppData\Local\Temp" "%CACHE_ROOT%\temp" /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 >NUL
    rmdir /S /Q "C:\Users\Administrator\AppData\Local\Temp" 2>NUL
)

REM Flutter SDK cache
if exist "C:\Users\Administrator\.flutter" (
    robocopy "C:\Users\Administrator\.flutter" "%CACHE_ROOT%\flutter" /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 >NUL
    rmdir /S /Q "C:\Users\Administrator\.flutter" 2>NUL
)
if exist "C:\Users\Administrator\flutter" (
    robocopy "C:\Users\Administrator\flutter" "%CACHE_ROOT%\flutter" /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 >NUL
    rmdir /S /Q "C:\Users\Administrator\flutter" 2>NUL
)

REM VS Code
if exist "C:\Users\Administrator\.vscode" (
    robocopy "C:\Users\Administrator\.vscode" "%CACHE_ROOT%\vscode" /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 >NUL
    rmdir /S /Q "C:\Users\Administrator\.vscode" 2>NUL
)

REM Gradle
if exist "C:\Users\Administrator\.gradle" (
    robocopy "C:\Users\Administrator\.gradle" "%CACHE_ROOT%\gradle" /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 >NUL
    rmdir /S /Q "C:\Users\Administrator\.gradle" 2>NUL
)

REM HuggingFace cache
if exist "C:\Users\Administrator\.cache\huggingface" (
    robocopy "C:\Users\Administrator\.cache\huggingface" "%PADDLE_ROOT%\hf" /E /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1 >NUL
    rmdir /S /Q "C:\Users\Administrator\.cache\huggingface" 2>NUL
)

echo === [3/4] Create junctions (C: -> D:) ===
if not exist "C:\Users\Administrator\.paddlex"  mklink /J "C:\Users\Administrator\.paddlex"   "%PADDLE_ROOT%\paddlex"   >NUL 2>&1
if not exist "C:\Users\Administrator\.paddleocr" mklink /J "C:\Users\Administrator\.paddleocr" "%PADDLE_ROOT%\paddleocr" >NUL 2>&1
if not exist "C:\Users\Administrator\.nuget"    mklink /J "C:\Users\Administrator\.nuget"     "%CACHE_ROOT%\nuget"     >NUL 2>&1
if not exist "C:\Users\Administrator\.vscode"   mklink /J "C:\Users\Administrator\.vscode"    "%CACHE_ROOT%\vscode"    >NUL 2>&1
if not exist "C:\Users\Administrator\.gradle"   mklink /J "C:\Users\Administrator\.gradle"    "%CACHE_ROOT%\gradle"    >NUL 2>&1
if not exist "C:\Users\Administrator\.flutter"  mklink /J "C:\Users\Administrator\.flutter"   "%CACHE_ROOT%\flutter"   >NUL 2>&1
if not exist "C:\Users\Administrator\.cache"    mklink /J "C:\Users\Administrator\.cache"     "%PADDLE_ROOT%\hf"       >NUL 2>&1
if not exist "C:\Users\Administrator\AppData\Local\pip"        mklink /J "C:\Users\Administrator\AppData\Local\pip"        "%PADDLE_ROOT%\pip"  >NUL 2>&1
if not exist "C:\Users\Administrator\AppData\Local\npm-cache"  mklink /J "C:\Users\Administrator\AppData\Local\npm-cache"  "%CACHE_ROOT%\npm"  >NUL 2>&1
if not exist "C:\Users\Administrator\AppData\Local\NuGet"     mklink /J "C:\Users\Administrator\AppData\Local\NuGet"     "%CACHE_ROOT%\nuget">NUL 2>&1
if not exist "C:\Users\Administrator\AppData\Local\Temp"      mklink /J "C:\Users\Administrator\AppData\Local\Temp"      "%CACHE_ROOT%\temp" >NUL 2>&1

REM Re-link sub-junction for HuggingFace inside .cache
if exist "C:\Users\Administrator\.cache" (
    if not exist "C:\Users\Administrator\.cache\huggingface" (
        mklink /J "C:\Users\Administrator\.cache\huggingface" "%PADDLE_ROOT%\hf" >NUL 2>&1
    )
)

echo === [4/4] Write user-level env vars (pointing to D:) ===
setx PIP_CACHE_DIR         "%PADDLE_ROOT%\pip"        >NUL
setx PADDLE_OCR_MODEL_DIR  "%PADDLE_ROOT%\paddleocr" >NUL
setx PPOCR_HOME            "%PADDLE_ROOT%\paddleocr" >NUL
setx PADDLE_PDX_CACHE_HOME "%PADDLE_ROOT%\paddlex"   >NUL
setx PADDLE_TMP_DIR        "%PADDLE_ROOT%\tmp"       >NUL
setx HF_HOME               "%PADDLE_ROOT%\hf"        >NUL
setx HUGGINGFACE_HUB_CACHE "%PADDLE_ROOT%\hf\hub"    >NUL
setx TEMP                  "%PADDLE_ROOT%\tmp"       >NUL
setx TMP                   "%PADDLE_ROOT%\tmp"       >NUL
setx TMPDIR                "%PADDLE_ROOT%\tmp"       >NUL
setx NPM_CONFIG_CACHE      "%CACHE_ROOT%\npm"        >NUL
setx NUGET_PACKAGES        "%CACHE_ROOT%\nuget"      >NUL
setx PUB_CACHE             "%PADDLE_ROOT%\pub"       >NUL

echo.
echo === D: contents ===
dir /B "%PADDLE_ROOT%"
echo ---
dir /B "%CACHE_ROOT%"
echo.
echo Done. Restart any running dev processes for the new junctions to take effect.
endlocal
