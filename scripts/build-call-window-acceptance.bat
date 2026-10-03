@echo off
rem Build the call-window transparency acceptance harness (real runner window
rem classes, no Flutter). ASCII-only file.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1

cd /d E:\ws-project\Private-Agent

cl /nologo /EHsc /O2 /W4 /WX /utf-8 /std:c++17 /DNOMINMAX /wd"4100" ^
  /I "client\flutter_app\windows\runner" ^
  scripts\call-window-transparency-acceptance.cpp ^
  client\flutter_app\windows\runner\outgoing_call_window.cpp ^
  client\flutter_app\windows\runner\incoming_call_window.cpp ^
  client\flutter_app\windows\runner\connected_call_window.cpp ^
  client\flutter_app\windows\runner\desktop_notification_window.cpp ^
  client\flutter_app\windows\runner\glass_notify_window.cpp ^
  /Fe:scripts\call-window-transparency-acceptance.exe ^
  /Fo:scripts\obj-call-acceptance\
if errorlevel 1 exit /b 1
echo BUILD OK
