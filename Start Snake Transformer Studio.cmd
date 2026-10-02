@echo off
setlocal
cd /d "%~dp0"
if defined PYTHON (
  "%PYTHON%" ipc_entry.py %*
  goto finished
)
if defined PYTHON (
  "%PYTHON%" ipc_entry.py %*
  goto finished
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 ipc_entry.py %*
  goto finished
)
where python >nul 2>nul
if not errorlevel 1 (
  python ipc_entry.py %*
  goto finished
)
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" ipc_entry.py %*
  goto finished
)
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" ipc_entry.py %*
  goto finished
)
echo Snake Transformer Studio needs Python 3.9 or later.
echo Install Python from https://www.python.org/downloads/ and run this launcher again.
echo No Python packages are needed for standalone browser mode.
pause
exit /b 1
:finished
if errorlevel 1 pause
endlocal
