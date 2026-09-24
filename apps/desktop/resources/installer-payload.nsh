; Included inside the install section, after the upstream extraction macro.
!macro PilotDeckConfirmUpgrade
  ; Never remove a registered installation while writing the replacement to
  ; another directory. This also catches future builder changes to /D handling.
  ${If} ${isUpdated}
    ReadRegStr $R2 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R2 != ""
    ${AndIf} $R2 != $INSTDIR
      DetailPrint "Update destination differs from the installed location: $R2"
      MessageBox MB_OK|MB_ICONSTOP "The update destination does not match the current installation. The existing version was kept. Please run the installer manually." /SD IDOK
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
  ReadRegStr $R0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R0 == ""
    ReadRegStr $R0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}
  ${If} $installMode == "all"
  ${AndIf} $R0 == ""
    ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${EndIf}
  ${If} $R0 != ""
  ${OrIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ; --updated is the updater's explicit replacement request. Plain /S must
    ; never implicitly authorize removal of an existing version.
    ${IfNot} ${Silent}
    ${OrIfNot} ${isUpdated}
      StrCpy $R1 "An existing version was found. Uninstall it and install this version? Choosing No keeps the existing installation."
      ${If} $LANGUAGE == 2052
      ${OrIf} $LANGUAGE == 1028
        StrCpy $R1 "检测到已安装版本。是否卸载旧版本并安装当前版本？选择“否”将保留原有安装。"
      ${EndIf}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$R1" /SD IDNO IDYES pilotdeck_upgrade_approved
      SetErrorLevel 1223
      Quit
      pilotdeck_upgrade_approved:
    ${EndIf}
  ${EndIf}
!macroend

!macro PilotDeckDiscard
  nsExec::ExecToLog '"$PLUGINSDIR\install-payload.exe" --discard "$PilotDeckState"'
  Pop $R9
!macroend

!macro PilotDeckCheckUninstall
  ${If} ${Errors}
  ${OrIf} $R0 != 0
    !insertmacro PilotDeckDiscard
    MessageBox MB_OK|MB_ICONEXCLAMATION "Unable to remove the previous version. Installation stopped; see details below." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macroundef extractUsing7za
!macro extractUsing7za ARCHIVE
  File /oname=$PLUGINSDIR\install-payload.exe "${PROJECT_DIR}\resources\.installer-tools\install-payload.exe"
  File /oname=$PLUGINSDIR\7za.exe "${PROJECT_DIR}\resources\.installer-tools\7za.exe"
  File /oname=$PLUGINSDIR\7zip-LICENSE.txt "${PROJECT_DIR}\resources\.installer-tools\LICENSE.txt"
  File /oname=$PLUGINSDIR\7zip-COPYING.txt "${PROJECT_DIR}\resources\.installer-tools\COPYING"
  StrCpy $R8 "en"
  ${If} $LANGUAGE == 2052
  ${OrIf} $LANGUAGE == 1028
    StrCpy $R8 "zh"
  ${EndIf}
  pilotdeck_extract_retry:
    SetDetailsPrint both
    nsExec::ExecToLog '"$PLUGINSDIR\install-payload.exe" "$PLUGINSDIR\7za.exe" "${ARCHIVE}" "$INSTDIR" "$HWNDPARENT" "$R8" "$PilotDeckState"'
    Pop $R9
    ; A cancellation confirmation can stay open after extraction finishes.
    ; Wait for that answer before crossing into the non-cancellable phase.
    ${DoWhile} $PilotDeckPhase == "confirm-cancel"
      Sleep 50
    ${Loop}
    ${If} $R9 == 1223
    ${OrIf} ${FileExists} "$PilotDeckState.cancel"
      !insertmacro PilotDeckDiscard
      SetErrorLevel 1223
      Quit
    ${EndIf}
    ${If} $R9 != 0
      SetDetailsView show
      StrCpy $R7 "Extraction failed. Check free disk space and see the details below before retrying."
      ${If} $R8 == "zh"
        StrCpy $R7 "解压未完成。请检查磁盘空间，并查看下方详情后重试。"
      ${EndIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$R7" /SD IDCANCEL IDRETRY pilotdeck_extract_retry
      SetErrorLevel 1
      Quit
    ${EndIf}

  ; The long extraction phase is cancellable. Protect uninstall/commit from
  ; interruption so filesystem, uninstaller and registry stay consistent.
  StrCpy $PilotDeckPhase "commit"
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 0
  DetailPrint "Files ready. Replacing installation and updating registration..."
  !insertmacro PilotDeckReplaceOldVersion
  ; The upstream uninstaller uses R8; restore the language before committing.
  StrCpy $R8 "en"
  ${If} $LANGUAGE == 2052
  ${OrIf} $LANGUAGE == 1028
    StrCpy $R8 "zh"
  ${EndIf}
  nsExec::ExecToLog '"$PLUGINSDIR\install-payload.exe" --commit "$PilotDeckState" "$HWNDPARENT" "$R8"'
  Pop $R9
  ${If} $R9 != 0
    SetDetailsView show
    MessageBox MB_OK|MB_ICONEXCLAMATION "Unable to complete installation. See details below and run the installer again." /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend
