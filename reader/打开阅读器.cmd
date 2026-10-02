@echo off
chcp 936 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node "%~dp0serve.mjs" %*
pause
exit /b

:nonode
echo.
echo   没有找到 Node.js，而阅读器的本地服务器要靠它运行。
echo.
echo   请到 https://nodejs.org/ 下载安装 LTS 版本，安装时保持默认选项一路下一步即可。
echo   装好以后重新双击本文件。
echo.
pause
