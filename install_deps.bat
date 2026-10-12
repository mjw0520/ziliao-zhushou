@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   资料助手 - 一键安装解析组件
echo   需要联网，请耐心等待（一般 1-5 分钟）
echo ============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Python。
  echo 请先安装 Python 3.9 或更高版本: https://www.python.org/downloads/
  echo 安装时请勾选 "Add Python to PATH" 选项。
  pause
  exit /b 1
)

echo 正在安装: pandas openpyxl xlrd pdfplumber python-docx python-pptx Pillow olefile
python -m pip install --disable-pip-version-check --upgrade pip >nul 2>nul
python -m pip install --disable-pip-version-check pandas openpyxl xlrd pdfplumber python-docx python-pptx Pillow olefile
if errorlevel 1 (
  echo.
  echo [错误] 安装失败，请检查网络后重试。
  echo 也可以手动打开命令行，运行上面这条 pip install 命令。
) else (
  echo.
  echo 安装完成！请关闭并重新打开资料助手（start.bat），组件即可生效。
)
pause
endlocal