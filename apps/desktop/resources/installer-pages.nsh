!include nsDialogs.nsh
!include WinMessages.nsh

; Align native installer pages with the restrained startup presentation.
!define MUI_BGCOLOR "FFFFFF"
!define MUI_TEXTCOLOR "171717"
!define MUI_INSTFILESPAGE_COLORS "171717 FFFFFF"
BrandingText "PilotDeck"

LangString PD_InstallTitle 1033 "Install PilotDeck"
LangString PD_InstallTitle 2052 "安装 PilotDeck"
LangString PD_InstallSubtitle 1033 "Your workspace is almost ready."
LangString PD_InstallSubtitle 2052 "即将准备好你的工作区。"
LangString PD_InstallBody 1033 "Choose an installation folder, then let PilotDeck finish preparing the application.$\r$\n$\r$\nYour existing personal data will be preserved when updating."
LangString PD_InstallBody 2052 "选择安装位置后，PilotDeck 会完成应用准备。$\r$\n$\r$\n更新已有版本时，会保留个人数据。"
LangString PD_DoneButton 1033 "Finish"
LangString PD_DoneButton 2052 "完成"
LangString PD_InstallDone 1033 "PilotDeck is ready"
LangString PD_InstallDone 2052 "PilotDeck 已准备就绪"
LangString PD_InstallDoneHelp 1033 "You can now open PilotDeck and start your next task."
LangString PD_InstallDoneHelp 2052 "现在可以打开 PilotDeck，开始下一项任务。"
LangString PD_Launch 1033 "Open PilotDeck"
LangString PD_Launch 2052 "启动 PilotDeck"

!macro customWelcomePage
  Var /GLOBAL PDWelcomeDialog
  Var /GLOBAL PDWelcomeFont
  Page custom PilotDeckWelcomeCreate
  Function PilotDeckWelcomeCreate
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "$(PD_InstallTitle)" "$(PD_InstallSubtitle)"
    nsDialogs::Create 1018
    Pop $PDWelcomeDialog
    SetCtlColors $PDWelcomeDialog "171717" "FFFFFF"
    ${NSD_CreateLabel} 0 16u 100% 30u "PilotDeck"
    Pop $0
    CreateFont $PDWelcomeFont "Segoe UI" 23 500
    SendMessage $0 ${WM_SETFONT} $PDWelcomeFont 1
    SetCtlColors $0 "171717" "FFFFFF"
    ${NSD_CreateLabel} 0 60u 100% 72u "$(PD_InstallBody)"
    Pop $0
    SetCtlColors $0 "626262" "FFFFFF"
    nsDialogs::Show
  FunctionEnd
!macroend

!macro PilotDeckFinishPage
  Var /GLOBAL PDFinishDialog
  Var /GLOBAL PDFinishFont
  Var /GLOBAL PDFinishRun
  Page custom PilotDeckFinishCreate PilotDeckFinishLeave
  Function PilotDeckFinishCreate
    !insertmacro MUI_HEADER_TEXT "$(PD_InstallDone)" ""
    nsDialogs::Create 1018
    Pop $PDFinishDialog
    SetCtlColors $PDFinishDialog "171717" "FFFFFF"
    ${NSD_CreateLabel} 0 16u 100% 30u "PilotDeck"
    Pop $0
    CreateFont $PDFinishFont "Segoe UI" 23 500
    SendMessage $0 ${WM_SETFONT} $PDFinishFont 1
    SetCtlColors $0 "171717" "FFFFFF"
    ${NSD_CreateLabel} 0 60u 100% 32u "$(PD_InstallDoneHelp)"
    Pop $0
    SetCtlColors $0 "626262" "FFFFFF"
    ${NSD_CreateCheckbox} 0 105u 100% 20u "$(PD_Launch)"
    Pop $PDFinishRun
    ${NSD_Check} $PDFinishRun
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(PD_DoneButton)"
    GetDlgItem $0 $HWNDPARENT 2
    EnableWindow $0 0
    nsDialogs::Show
  FunctionEnd
  Function PilotDeckFinishLeave
    ${NSD_GetState} $PDFinishRun $0
    ${If} $0 == ${BST_CHECKED}
      Call StartApp
    ${EndIf}
  FunctionEnd
!macroend

!ifdef BUILD_UNINSTALLER
  Var PDUnPageShown
  Var PDUnClean
  Var PDUnHome
  Var PDUnDialog
  Var PDUnKeep
  Var PDUnRemove
  Var PDUnFont

  LangString PD_UnTitle 1033 "Uninstall PilotDeck"
  LangString PD_UnTitle 2052 "卸载 PilotDeck"
  LangString PD_UnSubtitle 1033 "Choose what happens to your personal data."
  LangString PD_UnSubtitle 2052 "选择如何处理个人数据。"
  LangString PD_UnHeading 1033 "Keep your personal data?"
  LangString PD_UnHeading 2052 "要保留个人数据吗？"
  LangString PD_UnKeep 1033 "Keep personal data (recommended)"
  LangString PD_UnKeep 2052 "保留个人数据（推荐）"
  LangString PD_UnKeepHelp 1033 "Continue with your current settings and conversations if you reinstall."
  LangString PD_UnKeepHelp 2052 "以后重新安装时，可继续使用现有配置和会话。"
  LangString PD_UnClear 1033 "Remove personal data"
  LangString PD_UnClear 2052 "清理个人数据"
  LangString PD_UnClearHelp 1033 "Deletes all files in $PDUnHome, including credentials and conversations, plus this user's client settings and caches. Back up files you want to keep."
  LangString PD_UnClearHelp 2052 "将删除 $PDUnHome 中的全部文件（包括密钥和会话），以及当前用户的客户端设置和缓存。请提前备份需要保留的文件。"
  LangString PD_UnFallback 1033 "Also remove personal data?$\r$\n$\r$\n$(PD_UnClearHelp)$\r$\n$\r$\nSelect No to keep your data."
  LangString PD_UnFallback 2052 "是否同时清理个人数据？$\r$\n$\r$\n$(PD_UnClearHelp)$\r$\n$\r$\n选择“否”将保留个人数据。"
  LangString PD_UnPartial 1033 "Some personal data could not be removed. Your remaining files have been preserved."
  LangString PD_UnPartial 2052 "部分个人数据无法清理，剩余文件已保留。"
  LangString PD_UnDone 1033 "PilotDeck has been removed"
  LangString PD_UnDone 2052 "PilotDeck 已卸载"
  LangString PD_UnKept 1033 "Your personal data has been kept. It will be available when you reinstall."
  LangString PD_UnKept 2052 "个人数据已保留，重新安装后可以继续使用。"
  LangString PD_UnCleared 1033 "The selected personal data has been removed."
  LangString PD_UnCleared 2052 "所选个人数据已清理。"

  !macro customUnInit
    Push $0
    Push $1
    SetShellVarContext current
    ReadEnvStr $PDUnHome "PILOT_HOME"
    ${If} $PDUnHome == ""
      StrCpy $PDUnHome "$PROFILE\.pilotdeck"
    ${EndIf}
    ; Follow the client's saved UI language; fall back to the Windows UI language.
    System::Call 'kernel32::GetUserDefaultUILanguage() i.r0'
    IntOp $0 $0 & 1023
    StrCpy $LANGUAGE 1033
    ${If} $0 == 4
      StrCpy $LANGUAGE 2052
    ${EndIf}
    IfFileExists "$INSTDIR\resources\node\node.exe" 0 pilotdeck_un_language_done
    IfFileExists "$INSTDIR\resources\uninstall-data.cjs" 0 pilotdeck_un_language_done
    nsExec::ExecToStack '"$INSTDIR\resources\node\node.exe" "$INSTDIR\resources\uninstall-data.cjs" --language --profile "$PROFILE" --app-data "$APPDATA"'
    Pop $0
    Pop $1
    ${If} $0 == "0"
      ${If} $1 == "zh-CN"
        StrCpy $LANGUAGE 2052
      ${ElseIf} $1 == "en"
        StrCpy $LANGUAGE 1033
      ${EndIf}
    ${EndIf}
    pilotdeck_un_language_done:
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
    Pop $1
    Pop $0
  !macroend

  !macro customUnWelcomePage
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.PilotDeckProgressShow
    UninstPage custom un.PilotDeckDataCreate un.PilotDeckDataLeave
    Function un.PilotDeckDataCreate
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      ${If} ${Silent}
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "$(PD_UnTitle)" "$(PD_UnSubtitle)"
      nsDialogs::Create 1018
      Pop $PDUnDialog
      SetCtlColors $PDUnDialog "171717" "FFFFFF"
      ${NSD_CreateLabel} 0 4u 100% 26u "$(PD_UnHeading)"
      Pop $0
      CreateFont $PDUnFont "Segoe UI" 16 500
      SendMessage $0 ${WM_SETFONT} $PDUnFont 1
      SetCtlColors $0 "171717" "FFFFFF"
      ${NSD_CreateRadioButton} 0 44u 100% 18u "$(PD_UnKeep)"
      Pop $PDUnKeep
      ${NSD_Check} $PDUnKeep
      SetCtlColors $PDUnKeep "171717" "FFFFFF"
      ${NSD_CreateLabel} 13u 64u 94% 20u "$(PD_UnKeepHelp)"
      Pop $0
      SetCtlColors $0 "626262" "FFFFFF"
      ${NSD_CreateRadioButton} 0 94u 100% 18u "$(PD_UnClear)"
      Pop $PDUnRemove
      SetCtlColors $PDUnRemove "171717" "FFFFFF"
      ${NSD_CreateLabel} 13u 114u 94% 38u "$(PD_UnClearHelp)"
      Pop $0
      SetCtlColors $0 "626262" "FFFFFF"
      StrCpy $PDUnPageShown "1"
      StrCpy $PDUnClean "0"
      nsDialogs::Show
    FunctionEnd
    Function un.PilotDeckDataLeave
      ${NSD_GetState} $PDUnRemove $0
      StrCpy $PDUnClean "0"
      ${If} $0 == ${BST_CHECKED}
        StrCpy $PDUnClean "1"
      ${EndIf}
    FunctionEnd
    Function un.PilotDeckProgressShow
      FindWindow $0 "#32770" "" $HWNDPARENT
      GetDlgItem $1 $0 1004
      System::Call 'uxtheme::SetWindowTheme(p r1, w "", w "")'
      SendMessage $1 0x0409 0 0x171717
      SendMessage $1 0x2001 0 0xEEEEEE
    FunctionEnd
  !macroend

  !macro customUninstallPage
    UninstPage custom un.PilotDeckDoneCreate
    ; The following stock finish page is skipped in favor of this compact page.
    !define MUI_PAGE_CUSTOMFUNCTION_PRE un.PilotDeckSkipNativeFinish
    Function un.PilotDeckSkipNativeFinish
      Abort
    FunctionEnd
    Function un.PilotDeckDoneCreate
      !insertmacro MUI_HEADER_TEXT "$(PD_UnDone)" ""
      nsDialogs::Create 1018
      Pop $PDUnDialog
      SetCtlColors $PDUnDialog "171717" "FFFFFF"
      ${NSD_CreateLabel} 0 16u 100% 30u "PilotDeck"
      Pop $0
      CreateFont $PDUnFont "Segoe UI" 23 500
      SendMessage $0 ${WM_SETFONT} $PDUnFont 1
      SetCtlColors $0 "171717" "FFFFFF"
      StrCpy $1 "$(PD_UnKept)"
      ${If} $PDUnClean == "1"
        StrCpy $1 "$(PD_UnCleared)"
      ${ElseIf} $PDUnClean == "partial"
        StrCpy $1 "$(PD_UnPartial)"
      ${EndIf}
      ${NSD_CreateLabel} 0 60u 100% 60u "$1"
      Pop $0
      SetCtlColors $0 "626262" "FFFFFF"
      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $0 ${WM_SETTEXT} 0 "STR:$(PD_DoneButton)"
      GetDlgItem $0 $HWNDPARENT 2
      EnableWindow $0 0
      nsDialogs::Show
    FunctionEnd
  !macroend
!endif
