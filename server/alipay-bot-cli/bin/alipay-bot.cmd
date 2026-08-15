@echo off
setlocal
set "CLI_ROOT=%~dp0.."
node "%CLI_ROOT%\runtime\dist\cli.js" %*
exit /b %ERRORLEVEL%
