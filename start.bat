@echo off
chcp 65001 >nul
rem ============================================
rem  资料助手 启动脚本
rem  优先使用随附的 Python 运行时，找不到则用系统 python
rem ============================================
setlocal
cd /d "%~dp0"

set "PY="
if exist "C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
  set "PY=C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
)
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo [ERROR] Python not found. Please install Python 3.9 or newer.
  pause
  exit /b 1
)

echo Starting Knowledge Base...
"%PY%" app.py %*
if errorlevel 1 pause
endlocal