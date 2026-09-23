; PrivateAgent Windows 安装包（Inno Setup 6）
; 打包入口：scripts/release/build-installer.ps1（负责 staging，再调 ISCC 编译本文件）
; AppId 固定不变：覆盖安装/升级检测/卸载全靠它，永不可改。

#ifndef AppVersion
#define AppVersion "0.2.0"
#endif

; staging 目录由打包脚本经 /DStage 传入（默认短路径 E:\PAStage，避开深路径上限）
#ifndef Stage
#define Stage "E:\PAStage"
#endif

[Setup]
AppId={{D4A7F1B8-6C2E-4F9A-B3D8-91E05A7C4216}}
AppName=Nextbot
AppVersion={#AppVersion}
AppPublisher=Nextbot
DefaultDirName={autopf}\Nextbot
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
OutputDir=..\windows_dist\installer
OutputBaseFilename=Nextbot-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
UninstallDisplayIcon={app}\private_ai_agent.exe

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"; Flags: checkedonce

[Files]
Source: "{#Stage}\app\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion createallsubdirs
Source: "{#Stage}\runtime\*"; DestDir: "{app}\runtime"; Flags: recursesubdirs ignoreversion createallsubdirs

[Icons]
Name: "{autoprograms}\Nextbot"; Filename: "{app}\private_ai_agent.exe"
Name: "{autodesktop}\Nextbot"; Filename: "{app}\private_ai_agent.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\private_ai_agent.exe"; Description: "立即启动 Nextbot"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 故意不删 %APPDATA%\PrivateAgent（用户 key 与数据），安装器只管应用目录

[Code]
// 安装前停掉旧版本残留进程（限定路径在本应用目录内，不误杀系统其他 node）
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ErrorCode: Integer;
begin
  Exec(ExpandConstant('{cmd}'),
    '/C powershell -NoProfile -Command "Get-Process node,private_ai_agent -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ''' + ExpandConstant('{app}') + '*'' } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, ErrorCode);
  Sleep(800);
  Result := '';
end;
