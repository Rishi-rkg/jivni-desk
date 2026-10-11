; Windows installer for Jivni (Inno Setup 6). Built by packaging/build.py, which passes the version and
; processor type:  ISCC /DAppVersion=0.1.0 /DArch=x64 packaging\windows\jivni.iss
;
; Installs for the current user only, so it needs no administrator password. The clinic's data lives in
; a separate folder (%LOCALAPPDATA%\Jivni) and is never touched by installing, updating or uninstalling.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef Arch
  #define Arch "x64"
#endif

[Setup]
; Never change AppId: Windows uses it to recognise an update of the same application.
AppId={{174C155D-0D54-48C8-A313-7BEF2CCC6DBA}
AppName=Jivni
AppVersion={#AppVersion}
AppVerName=Jivni {#AppVersion}
AppPublisher=Jivni
DefaultDirName={localappdata}\Programs\Jivni
DefaultGroupName=Jivni
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist\release
OutputBaseFilename=Jivni-{#AppVersion}-windows-{#Arch}-setup
SetupIconFile=..\icons\jivni.ico
UninstallDisplayIcon={app}\Jivni.exe
UninstallDisplayName=Jivni
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
#if Arch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif
; Close a running copy before replacing its files, and start it again afterwards.
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"
Name: "autostart"; Description: "Start Jivni when I sign in to Windows"

[Files]
Source: "..\..\dist\Jivni\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Jivni"; Filename: "{app}\Jivni.exe"
Name: "{autodesktop}\Jivni"; Filename: "{app}\Jivni.exe"; Tasks: desktopicon
; Started with the computer it stays quietly in the tray; the browser opens only when asked.
Name: "{userstartup}\Jivni"; Filename: "{app}\Jivni.exe"; Parameters: "--no-browser"; Tasks: autostart

[Run]
Filename: "{app}\Jivni.exe"; Description: "Start Jivni now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/C taskkill /IM Jivni.exe /F"; Flags: runhidden; RunOnceId: "StopJivni"

[Messages]
ConfirmUninstall=Remove %1 from this computer?%n%nYour clinic's records and settings are kept. They are in the Jivni data folder and are not deleted.
