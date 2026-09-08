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

; Both the interactive finish page and silent --force-run updates must use
; explorer.exe to de-elevate, avoiding StdUtils.ExecShellAsUser hanging.
; The custom include precedes common.nsh. Replace its macro from customHeader,
; after common.nsh is loaded and before the install section is expanded.
!macro customHeader
  !macroundef StartApp
  !include "installer-start-app.nsh"
!macroend

!macro PilotDeckStartApp
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
!macroend

!macro customFinishPage
  Function StartApp
    !insertmacro PilotDeckStartApp
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
