@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-dsh-release.ps1" %*
if errorlevel 1 (pause & exit /b 1)
pause
