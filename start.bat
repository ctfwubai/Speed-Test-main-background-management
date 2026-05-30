@echo off
cd /d "%~dp0"
title Intranet Speed Test v2.0

:: Usage: start.bat [port] [password]
:: Example: start.bat 9090 mypassword

set PORT=%1
if "%PORT%"=="" set PORT=8081

if not "%2"=="" set ADMIN_PASSWORD=%2

echo ================================================
echo    Intranet Speed Test v2.0
echo ================================================
echo.

:: [1] Check Node.js
echo [1/4] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)
for /f %%i in ('node -v') do set NODE_VER=%%i
echo [OK] Node.js %NODE_VER%

:: [2] Install dependencies
echo [2/4] Checking dependencies...
if not exist "node_modules\" (
    echo    Installing...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [FAIL] npm install failed. Try: npm install
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed
) else (
    echo [OK] Dependencies ready
)

:: [3] Kill existing Node.js processes (fix port conflicts)
echo [3/4] Stopping existing Node.js server...
taskkill /f /im node.exe >nul 2>&1
if errorlevel 1 (echo [OK] No running server found) else (echo [OK] Existing Node.js process^(es^) stopped)
echo [OK] Port %PORT% available

:: [4] Start server
echo [4/4] Starting server...
echo.
cls

echo ================================================
echo    Intranet Speed Test v2.0
echo ================================================
echo.
echo   Server: http://localhost:%PORT%
echo   Admin:  http://localhost:%PORT%/console/login.html
if not "%ADMIN_PASSWORD%"=="" (
    echo   Password: custom
) else (
    echo   Default password: admin123
)
echo.
echo   Press Ctrl+C to stop
echo ================================================
echo.

set PORT=%PORT%
node server.js

if errorlevel 1 (
    echo Server stopped with code %ERRORLEVEL%
    pause
)
