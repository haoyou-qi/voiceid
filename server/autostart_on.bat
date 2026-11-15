@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
(
  echo @echo off
  echo start "VoiceID" /min cmd /c "%~dp0start_server.bat"
) > "%STARTUP%\VoiceID電腦運算.bat"
echo 已設定：以後開機登入 Windows 時，會自動在背景啟動 VoiceID 電腦運算服務（縮小在工作列）。
echo.
echo 另外建議：插電時不要讓電腦睡眠，朋友才隨時連得到。
choice /c YN /m "要把「插電時自動睡眠」改成「永不」嗎"
if errorlevel 2 goto done
powercfg /change standby-timeout-ac 0
echo 已設定插電時永不睡眠（螢幕還是會照原本設定關閉）。
:done
echo.
echo 要取消開機啟動：雙擊 autostart_off.bat
pause
