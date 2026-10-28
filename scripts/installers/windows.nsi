Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
Name "Achbit"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Achbit"
InstallDirRegKey HKCU "Software\Achbit" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Var InstallLock
Var RestartApp
Var RestartArgs
!define MUI_ABORTWARNING
!define MUI_CUSTOMFUNCTION_ABORT ReleaseInstallLock
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  StrCpy $InstallLock -1
  StrCpy $RestartApp 0
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Achbit requires 64-bit Windows."
    Abort
  ${EndIf}
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/P" $R1
  ${IfNot} ${Errors}
    SetSilent silent
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/R" $R1
  ${IfNot} ${Errors}
    StrCpy $RestartApp 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/ARGS " $RestartArgs
  ClearErrors
FunctionEnd

Function ReleaseInstallLock
  ${If} $InstallLock != -1
    System::Call 'kernel32::CloseHandle(p $InstallLock)'
    StrCpy $InstallLock -1
  ${EndIf}
FunctionEnd

Function .onInstSuccess
  Call ReleaseInstallLock
  ${If} $RestartApp == 1
    Exec '"$INSTDIR\Achbit.exe" $RestartArgs'
  ${EndIf}
FunctionEnd
Function .onInstFailed
  Call ReleaseInstallLock
FunctionEnd

Section "Achbit" Main
  SetShellVarContext current
  ${GetParent} "$INSTDIR" $R2
  ${GetFileName} "$INSTDIR" $R3
  CreateDirectory "$R2"
  StrCpy $R4 "$R2\.$R3.runtime.lock"
  StrCpy $R5 0
  acquire:
    System::Call 'kernel32::CreateFileW(w "$R4", i 0xC0000000, i 0, p 0, i 4, i 0x80, p 0) p .r0'
    StrCpy $InstallLock $0
    ${If} $InstallLock == -1
      IntOp $R5 $R5 + 1
      ${If} $R5 > 300
        MessageBox MB_ICONSTOP "Achbit is still running. Close its windows and terminal clients, then retry."
        Abort
      ${EndIf}
      Sleep 100
      Goto acquire
    ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\runtime"
  File /r "${STAGE}/*"
  SetOutPath "$PLUGINSDIR"
  File /oname=install-runtime.ps1 "${INSTALL_RUNTIME}"
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-runtime.ps1" -Stage "$PLUGINSDIR\runtime" -Destination "$INSTDIR"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Achbit program replacement failed (exit $0). The installer retained the previous program or its recovery files."
    Abort
  ${EndIf}
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\libexec\windows-environment.ps1"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Achbit environment setup failed (exit $0). Check the setup error and retry."
    Abort
  ${EndIf}
  System::Call 'user32::SendMessageTimeoutW(p 0xffff, i 0x1a, p 0, w "Environment", i 2, i 5000, *p .r0)'
  CreateDirectory "$SMPROGRAMS\Achbit"
  CreateShortcut "$SMPROGRAMS\Achbit\Achbit.lnk" "$INSTDIR\Achbit.exe"
  CreateShortcut "$SMPROGRAMS\Achbit\Achbit TUI.lnk" "$INSTDIR\achbit-tui.bat"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Achbit" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Achbit" "DisplayName" "Achbit"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Achbit" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Achbit" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Achbit" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Achbit" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Achbit" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ; Remove workspace Shell sandbox grants and profiles of this user; user files stay.
  ExecWait '"$INSTDIR\achbit-kernel.exe" --workspace-sandbox-reset' $1
  ${If} $1 != 0
    DetailPrint "Workspace sandbox reset reported exit $1; continuing uninstall."
  ${EndIf}
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\libexec\windows-environment.ps1" -Remove' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Cannot remove the Achbit PATH entry (exit $0). Uninstall stopped."
    Abort
  ${EndIf}
  System::Call 'user32::SendMessageTimeoutW(p 0xffff, i 0x1a, p 0, w "Environment", i 2, i 5000, *p .r0)'
  !include "${UNINSTALL_FILES}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Achbit\Achbit.lnk"
  Delete "$SMPROGRAMS\Achbit\Achbit TUI.lnk"
  RMDir "$SMPROGRAMS\Achbit"
  DeleteRegKey HKCU "Software\Achbit"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Achbit"
SectionEnd
