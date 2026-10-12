@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   资料助手 - 一键打包全部版本
echo   改完源码后双击本脚本，两个版本一起重新生成：
echo     1) 资料助手.exe         Win10/11 版
echo     2) Win7版\资料助手.exe   Win7 版
echo ============================================
echo.

REM ---- 构建环境 ----
set PY_WIN=E:\资料助手-开发环境\venv-win\Scripts\python.exe
set PY_WIN7=E:\资料助手-开发环境\py39\python.exe
set SRC=%~dp0

if not exist "%PY_WIN%" ( echo [错误] 找不到 %PY_WIN% & pause & exit /b 1 )
if not exist "%PY_WIN7%" ( echo [错误] 找不到 %PY_WIN7% & pause & exit /b 1 )

echo [提示] 打包前请先关闭正在运行的资料助手程序，否则可能因文件占用失败。
pause

echo.
echo [0/4] 清理旧 exe（避免覆盖时被占用）...
if exist "%SRC%资料助手.exe" del /f /q "%SRC%资料助手.exe" >nul 2>nul
if exist "%SRC%Win7版\资料助手.exe" del /f /q "%SRC%Win7版\资料助手.exe" >nul 2>nul
if exist "%SRC%Win7版\资料助手.exe.notanexecutable" del /f /q "%SRC%Win7版\资料助手.exe.notanexecutable" >nul 2>nul
echo [完成] 旧 exe 已清理

echo.
echo [1/4] 打包 Win10/11 版 ...
"%PY_WIN%" -m PyInstaller --noconfirm --clean --onefile --windowed --name 资料助手 --icon "%SRC%icon.ico" --add-data "%SRC%static;static" --collect-submodules pdfplumber --collect-submodules pdfminer --distpath "%SRC%." --workpath "%SRC%build_win" --specpath "%SRC%build_win" "%SRC%app.py"
if errorlevel 1 ( echo [错误] Win10/11 版打包失败 & pause & exit /b 1 )
echo [完成] 资料助手.exe

echo.
echo [2/4] 打包 Win7 版 ...
if not exist "Win7版" mkdir "Win7版"
"%PY_WIN7%" -m PyInstaller --noconfirm --clean --onefile --windowed --name 资料助手 --icon "%SRC%icon.ico" --add-data "%SRC%static;static" --collect-submodules pdfplumber --collect-submodules pdfminer --distpath "%SRC%Win7版" --workpath "%SRC%build_win7" --specpath "%SRC%build_win7" "%SRC%app.py"
if errorlevel 1 ( echo [错误] Win7 版打包失败 & pause & exit /b 1 )
echo [完成] Win7版\资料助手.exe

echo.
echo [3/4] 同步数据与说明、刷新分发包 ...
robocopy data "Win7版\data" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NP >nul
copy /Y "使用说明-Win7.txt" "Win7版\使用说明.txt" >nul
robocopy data "分发包\data" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NP >nul
copy /Y "资料助手.exe" "分发包\资料助手.exe" >nul
copy /Y "使用说明.txt" "分发包\使用说明.txt" >nul
powershell -NoProfile -Command "Compress-Archive -Path '分发包\*' -DestinationPath '资料助手-分发包.zip' -Force"
powershell -NoProfile -Command "Compress-Archive -Path 'Win7版\*' -DestinationPath '资料助手-分发包-Win7.zip' -Force"
echo [完成] 分发包与 zip 已刷新

echo.
echo [4/4] 生成程序纯净版 zip（只含 exe + 使用说明，不带任何数据）...
if exist "build_pkg" rmdir /s /q "build_pkg"
mkdir "build_pkg\std" "build_pkg\win7" 2>nul
copy /Y "资料助手.exe" "build_pkg\std\" >nul
copy /Y "使用说明.txt" "build_pkg\std\" >nul
copy /Y "Win7版\资料助手.exe" "build_pkg\win7\" >nul
copy /Y "使用说明-Win7.txt" "build_pkg\win7\" >nul
powershell -NoProfile -Command "Compress-Archive -Path 'build_pkg\std\*' -DestinationPath '资料助手-程序版.zip' -Force"
powershell -NoProfile -Command "Compress-Archive -Path 'build_pkg\win7\*' -DestinationPath '资料助手-程序版-Win7.zip' -Force"
echo [完成] 程序纯净版 zip 已生成

echo.
echo 清理构建中间文件 ...
if exist "build_win" rmdir /s /q "build_win"
if exist "build_win7" rmdir /s /q "build_win7"
if exist "build_pkg" rmdir /s /q "build_pkg"
if exist "build_pkg" rmdir /s /q "build_pkg"

echo.
echo ============================================
echo   全部完成！
echo     Win10/11 : 资料助手.exe
echo     Win7     : Win7版\资料助手.exe
echo     分发包    : 资料助手-分发包.zip / 资料助手-分发包-Win7.zip（带示例数据）
echo     纯净版    : 资料助手-程序版.zip / 资料助手-程序版-Win7.zip（不带数据）
echo ============================================
pause
endlocal