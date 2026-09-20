; Custom app-running check for the NSIS installer AND uninstaller.
; Replaces electron-builder's default (templates/nsis/include/allowOnlyOneInstallerInstance.nsh),
; which matches processes by $INSTDIR path prefix or a tasklist USERNAME
; filter — both miss common cases (tray-resident instance, elevated instance,
; exe running from another dir), after which the install deadlocks on the
; locked executable with no prompt at all.
;
; This variant detects by process image name only, which is robust for all
; of the above, then asks before force-killing.
!macro customCheckAppRunning
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $R0
  ${If} $R0 == 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "检测到 ${PRODUCT_NAME} 正在运行。$\n$\n点击「确定」自动关闭它并继续，或「取消」退出安装程序。" /SD IDOK IDOK bdcr_proceed
    Quit
    bdcr_proceed:
    DetailPrint "正在关闭正在运行的 ${PRODUCT_NAME}…"
    nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $R0
    Sleep 800
    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $R0
    ${If} $R0 == 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "无法自动关闭 ${PRODUCT_NAME}（可能以管理员权限运行）。$\n请手动退出应用后，重新运行安装程序。"
      Quit
    ${EndIf}
  ${EndIf}
!macroend
