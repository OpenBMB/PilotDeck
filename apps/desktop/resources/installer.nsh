; Custom NSIS include for PilotDeck
; Fix: UAC elevation inner process loses the MUI_ICON window icon.
; After GUI init, explicitly reload the icon from the running exe
; and set it on the installer window via WM_SETICON.

!define MUI_CUSTOMFUNCTION_GUIINIT fixInstallerIcon

Function fixInstallerIcon
  System::Call "shell32::ExtractIcon(p 0, t '$EXEPATH', i 0) p .r0"
  StrCmp $r0 0 done
    SendMessage $HWNDPARENT 0x0080 0 $r0
    SendMessage $HWNDPARENT 0x0080 1 $r0
  done:
FunctionEnd
