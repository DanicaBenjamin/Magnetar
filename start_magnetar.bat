@echo off
title MAGNETAR Dashboard & Serial Bridge
cd /d "%~dp0"

echo ======================================================================
echo  MAGNETAR - Geomagnetic Storm Early Warning Station
echo  Starting local bridge and web interface...
echo ======================================================================

:: Prefer explicit Python 3.13 installation first to bypass Windows Store alias
if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" (
    set "PY_CMD=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
) else if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
    set "PY_CMD=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
) else (
    set PY_CMD=python
)

echo Using Python: %PY_CMD%

:: Launch default web browser after 1.5 seconds in background
start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:8080"

:: Start the Python bridge on COM7
"%PY_CMD%" bridge.py --port 8080 --serial COM7
pause
