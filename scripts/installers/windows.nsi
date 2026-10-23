Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
Name "Achbit"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\DeepCode"
InstallDirRegKey HKCU "Software\DeepCode" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Achbit requires 64-bit Windows."
    Abort
  ${EndIf}
FunctionEnd

Section "Achbit" Main
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${STAGE}/*"
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\libexec\windows-environment.ps1"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Achbit environment or user configuration setup failed (exit $0). Close Achbit, check the setup error, and rerun Setup."
    Abort
  ${EndIf}
  System::Call 'user32::SendMessageTimeoutW(p 0xffff, i 0x1a, p 0, w "Environment", i 2, i 5000, *p .r0)'
  CreateDirectory "$SMPROGRAMS\Achbit"
  CreateShortcut "$SMPROGRAMS\Achbit\Achbit.lnk" "$INSTDIR\Achbit.exe"
  CreateShortcut "$SMPROGRAMS\Achbit\Achbit TUI.lnk" "$INSTDIR\achbit-tui.bat"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\DeepCode" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepCode" "DisplayName" "Achbit"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepCode" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepCode" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepCode" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepCode" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepCode" "NoRepair" 1
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
  DeleteRegKey HKCU "Software\DeepCode"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepCode"
SectionEnd
