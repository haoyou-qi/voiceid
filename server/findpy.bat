@echo off
rem 找 Python（Anaconda / 一般安裝都可以），結果放在 PY 變數
set "PY="
rem 安裝後會有專用的獨立環境（.venv），優先使用
if exist "%~dp0.venv\Scripts\python.exe" (
  set "PY=%~dp0.venv\Scripts\python.exe"
  goto :eof
)
if "%~1"=="venv" goto :eof
if exist "%~dp0python_path.txt" (
  set /p PY=<"%~dp0python_path.txt"
)
if defined PY if exist "%PY%" goto :eof
set "PY="
for %%P in (
  "%ProgramData%\anaconda3\python.exe"
  "%USERPROFILE%\anaconda3\python.exe"
  "%LOCALAPPDATA%\anaconda3\python.exe"
  "C:\anaconda3\python.exe"
  "D:\anaconda3\python.exe"
  "C:\Anaconda3\python.exe"
  "D:\Anaconda\python.exe"
  "%USERPROFILE%\miniconda3\python.exe"
  "%ProgramData%\miniconda3\python.exe"
) do (
  if not defined PY if exist %%P set "PY=%%~P"
)
if not defined PY (
  for /f "delims=" %%i in ('python -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%i"
)
if not defined PY (
  for /f "delims=" %%i in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%i"
)
if defined PY (>"%~dp0python_path.txt" echo %PY%)
goto :eof
