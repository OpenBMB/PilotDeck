; Custom NSIS include for PilotDeck

; Fix 1: Reload icon after UAC elevation to prevent title bar icon loss.
!define MUI_CUSTOMFUNCTION_GUIINIT fixInstallerIcon

Function fixInstallerIcon
  System::Call "shell32::ExtractIcon(p 0, t '$EXEPATH', i 0) p .r0"
  StrCmp $r0 0 done
    SendMessage $HWNDPARENT 0x0080 0 $r0
    SendMessage $HWNDPARENT 0x0080 1 $r0
  done:
FunctionEnd

; Fix 2: Override finish page to launch the app via explorer.exe,
; which de-elevates naturally and avoids StdUtils.ExecShellAsUser hang.
!macro customFinishPage
  Function StartApp
    Exec '"$WINDIR\explorer.exe" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
