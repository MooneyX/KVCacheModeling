@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local.ps1" %*
set "result=%errorlevel%"
if not "%result%"=="0" (
  echo.
  echo Local startup failed. See the error above and .runtime\local\ logs.
  pause
)
exit /b %result%
