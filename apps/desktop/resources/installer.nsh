; Custom NSIS include for PilotDeck
!include LogicLib.nsh
!include "${PROJECT_DIR}\resources\installer-pages.nsh"

; Updates and silent removal never ask about or clean personal data.
!macro customUnInstall
  ${IfNot} ${isUpdated}
  ${AndIfNot} ${Silent}
    Push $0
    Push $1
    SetShellVarContext current
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(PD_UnFallback)" IDNO pilotdeck_keep_personal_data

      IfFileExists "$INSTDIR\resources\node\node.exe" 0 pilotdeck_cleanup_unavailable
      IfFileExists "$INSTDIR\resources\uninstall-data.cjs" 0 pilotdeck_cleanup_unavailable
      nsExec::ExecToStack '"$INSTDIR\resources\node\node.exe" "$INSTDIR\resources\uninstall-data.cjs" --profile "$PROFILE" --app-data "$APPDATA" --local-app-data "$LOCALAPPDATA" --pilot-home "$PDUnHome"'
      Pop $0
      Pop $1
      StrCmp $0 "0" pilotdeck_keep_personal_data
      pilotdeck_cleanup_unavailable:
        MessageBox MB_OK|MB_ICONINFORMATION "$(PD_UnPartial)"
    pilotdeck_keep_personal_data:
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
    Pop $1
    Pop $0
  ${EndIf}
!macroend
!ifndef BUILD_UNINSTALLER
  Var PilotDeckPhase
  Var PilotDeckState
  Var PilotDeckProgress
  Var PilotDeckReplaceMode
  !define MUI_CUSTOMFUNCTION_ABORT PilotDeckAbort
!endif

; Fix 1: Reload icon after UAC elevation to prevent title bar icon loss.
!define MUI_CUSTOMFUNCTION_GUIINIT fixInstallerIcon

Function fixInstallerIcon
  System::Call "shell32::ExtractIcon(p 0, t '$EXEPATH', i 0) p .r0"
  StrCmp $r0 0 done
    SendMessage $HWNDPARENT 0x0080 0 $r0
    SendMessage $HWNDPARENT 0x0080 1 $r0
  done:
FunctionEnd

; Both the interactive finish page and silent --force-run updates must use
; explorer.exe to de-elevate, avoiding StdUtils.ExecShellAsUser hanging.
; The custom include precedes common.nsh. Replace its macro from customHeader,
; after common.nsh is loaded and before the install section is expanded.
!macro customHeader
  !macroundef StartApp
  ; NsisTarget expands this macro from its template directory, not resources/.
  !include "${PROJECT_DIR}\resources\installer-start-app.nsh"
  ShowInstDetails hide
!macroend

; Define this immediately before MUI_PAGE_INSTFILES, after the directory page.
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW PilotDeckInstallPageShow
!macroend

!ifndef BUILD_UNINSTALLER
Function PilotDeckInstallPageShow
  InitPluginsDir
  StrCpy $PilotDeckState "$PLUGINSDIR\payload.state"
  ; NSIS updates its native bar per instruction, including each log line.
  ; Maintain a separate cumulative control at the same position.
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $1 $0 1004
  ; Inherit the stock NSIS control's styles and theme instead of forcing a
  ; classic control. Windows retains its normal progress transition animation.
  System::Call 'user32::GetWindowLong(p r1, i -16) i.r7'
  System::Call 'user32::GetWindowLong(p r1, i -20) i.r8'
  System::Call 'uxtheme::GetWindowTheme(p r1) p.r9'
  System::Call '*(i, i, i, i) p .r2'
  System::Call 'user32::GetWindowRect(p r1, p r2)'
  System::Call 'user32::MapWindowPoints(p 0, p r0, p r2, i 2)'
  System::Call '*$2(i .r3, i .r4, i .r5, i .r6)'
  System::Free $2
  IntOp $5 $5 - $3
  IntOp $6 $6 - $4
  ; Mirror the full-size native bar; only its cumulative value is managed.
  ShowWindow $1 0
  System::Call 'user32::CreateWindowEx(i r8, t "msctls_progress32", t "", i r7, i r3, i r4, i r5, i r6, p r0, p 1136, p 0, p 0) p .r2'
  ${If} $9 == 0
    System::Call 'uxtheme::SetWindowTheme(p r2, w "", w "")'
  ${EndIf}
  StrCpy $PilotDeckProgress $2
  SendMessage $PilotDeckProgress 0x0406 0 1000
  GetDlgItem $1 $HWNDPARENT 2
  EnableWindow $1 1
  StrCpy $PilotDeckPhase "prepare"
  SetDetailsPrint both
  ${If} $LANGUAGE == 2052
  ${OrIf} $LANGUAGE == 1028
    DetailPrint "正在准备安装。解压阶段可以取消，旧版本将在文件准备完成后替换。"
  ${Else}
    DetailPrint "Preparing installation. You can cancel extraction; replacement begins only after the files are ready."
  ${EndIf}
FunctionEnd

Function PilotDeckAbort
  ${If} $PilotDeckPhase == "prepare"
    StrCpy $PilotDeckPhase "confirm-cancel"
    Push $0
    Push $1
    StrCpy $0 "Cancel installation? The existing version will be kept."
    ${If} $LANGUAGE == 2052
    ${OrIf} $LANGUAGE == 1028
      StrCpy $0 "是否取消安装？已安装的旧版本将保留。"
    ${EndIf}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$0" IDNO pilotdeck_keep_installing
    ; Cooperatively stop the decoder before closing the installer.
    FileOpen $1 "$PilotDeckState.cancel" w
    FileWrite $1 "cancel"
    FileClose $1
    GetDlgItem $1 $HWNDPARENT 2
    EnableWindow $1 0
    pilotdeck_keep_installing:
    StrCpy $PilotDeckPhase "prepare"
    Pop $1
    Pop $0
    Abort
  ${EndIf}
  ${If} $PilotDeckPhase == "commit"
    Abort
  ${EndIf}
FunctionEnd
!endif

!macro customInstall
  StrCpy $PilotDeckPhase "done"
  SendMessage $PilotDeckProgress 0x0402 1000 0
  SetDetailsPrint both
  ${If} $LANGUAGE == 2052
  ${OrIf} $LANGUAGE == 1028
    DetailPrint "安装完成。"
  ${Else}
    DetailPrint "Installation complete."
  ${EndIf}
!macroend

!macro PilotDeckStartApp
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
!macroend

!macro PilotDeckDesktopShortcut directory
  CreateShortCut "${directory}\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${PRODUCT_NAME}"
  ${IfNot} ${Errors}
    WinShell::SetLnkAUMI "${directory}\${PRODUCT_NAME}.lnk" "${APP_ID}"
  ${EndIf}
!macroend

!macro customFinishPage
  Function StartApp
    !insertmacro PilotDeckStartApp
  FunctionEnd

  Function PilotDeckCreateDesktopShortcut
    ClearErrors
    !insertmacro PilotDeckDesktopShortcut "$DESKTOP"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONINFORMATION "$(PD_ShortcutFailed)" /SD IDOK
    ${EndIf}
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "$(PD_StartApplication)"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "$(PD_DesktopShortcut)"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "PilotDeckCreateDesktopShortcut"
  !insertmacro MUI_PAGE_FINISH
!macroend
