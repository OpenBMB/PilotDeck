!include WinMessages.nsh

; Keep electron-builder's native pages, fonts and progress controls.
InstProgressFlags colored
!define MUI_INSTFILESPAGE_PROGRESSBAR colored

LangString PD_InvalidUpdateLocation 1033 "The update destination does not match the current installation. The existing version was kept. Please run the installer manually."
LangString PD_InvalidUpdateLocation 2052 "更新目标与当前安装位置不一致，现有版本已保留。请手动运行安装程序。"
LangString PD_UnableRemove 1033 "Unable to remove the previous version. Installation stopped; see details below."
LangString PD_UnableRemove 2052 "无法移除旧版本，安装已停止。请查看下方详情。"
LangString PD_FilesReady 1033 "Files ready. Replacing installation and updating registration..."
LangString PD_FilesReady 2052 "文件已准备完成，正在替换程序并更新注册信息……"
LangString PD_UnableComplete 1033 "Unable to complete installation. See details below and run the installer again."
LangString PD_UnableComplete 2052 "无法完成安装。请查看下方详情后重新运行安装程序。"
LangString PD_DesktopShortcut 1033 "Create a desktop shortcut"
LangString PD_DesktopShortcut 2052 "创建桌面快捷方式"
LangString PD_StartApplication 1033 "Start PilotDeck"
LangString PD_StartApplication 2052 "启动 PilotDeck"
LangString PD_ShortcutFailed 1033 "PilotDeck was installed, but the desktop shortcut could not be created. You can open PilotDeck from the Start menu."
LangString PD_ShortcutFailed 2052 "PilotDeck 已安装，但无法创建桌面快捷方式。你可以从开始菜单启动 PilotDeck。"

!ifdef BUILD_UNINSTALLER
  ; Creation is deferred to the finish-page checkbox, but the normal
  ; uninstaller must still remove the shortcut owned by this application.
  !ifdef DO_NOT_CREATE_DESKTOP_SHORTCUT
    !undef DO_NOT_CREATE_DESKTOP_SHORTCUT
  !endif
  Var PDUnHome
  !macro customUnWelcomePage
    !insertmacro MUI_UNPAGE_WELCOME
  !macroend
  LangString PD_UnClearHelp 1033 "Deletes all files in $PDUnHome, including credentials and conversations, plus this user's client settings and caches. Back up files you want to keep."
  LangString PD_UnClearHelp 2052 "将删除 $PDUnHome 中的全部文件（包括密钥和会话），以及当前用户的客户端设置和缓存。请提前备份需要保留的文件。"
  LangString PD_UnFallback 1033 "Also remove personal data?$\r$\n$\r$\n$(PD_UnClearHelp)$\r$\n$\r$\nSelect No to keep your data."
  LangString PD_UnFallback 2052 "是否同时清理个人数据？$\r$\n$\r$\n$(PD_UnClearHelp)$\r$\n$\r$\n选择“否”将保留个人数据。"
  LangString PD_UnPartial 1033 "Some personal data could not be removed. Your remaining files have been preserved."
  LangString PD_UnPartial 2052 "部分个人数据无法清理，剩余文件已保留。"

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
!endif
