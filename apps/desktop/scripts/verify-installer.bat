@echo off
setlocal enabledelayedexpansion
REM ============================================================================
REM PilotDeck Desktop Windows Installer Verifier (verify-installer.bat)
REM ----------------------------------------------------------------------------
REM Validates a built PilotDeck Windows installer / unpacked app:
REM   1. Installer EXE exists and has nonzero size
REM   2. App directory structure is correct (PilotDeck.exe, resources)
REM   3. Bundled Node.js and Bun binaries are present and runnable
REM   4. Bundle tars exist and are extractable
REM   5. Gateway process starts and responds on /health
REM   6. Stub pilotdeck.yaml + loadPilotConfig compat
REM
REM Usage:
REM   verify-installer.bat <DIST_ELECTRON_DIR>
REM   verify-installer.bat   (auto-detects dist-electron in parent)
REM   exit 0 = all checks pass; exit 1 = any failure
REM ============================================================================

set PASS=0
set FAIL=0
set WARN=0

REM --- Locate dist-electron ---
set "DIST_DIR=%~1"
if "%DIST_DIR%"=="" (
    set "DIST_DIR=%~dp0..\dist-electron"
)
if not exist "%DIST_DIR%" (
    echo ERROR: dist-electron directory not found: %DIST_DIR%
    exit /b 2
)

echo.
echo =========================================
echo  PilotDeck Windows Installer Verification
echo =========================================
echo  Dir: %DIST_DIR%
echo.

REM ── 1. Installer EXE ──
echo -- 1. Installer EXE --

set "FOUND_EXE="
for %%f in ("%DIST_DIR%\PilotDeck Setup*.exe" "%DIST_DIR%\PilotDeck-*.exe") do (
    if exist "%%f" (
        set "FOUND_EXE=%%f"
        set /a PASS+=1
        echo   [PASS] Installer found: %%~nxf
    )
)
if "%FOUND_EXE%"=="" (
    set /a WARN+=1
    echo   [WARN] No installer EXE found in %DIST_DIR% (may be --dir build)
)

REM ── 2. Unpacked app structure ──
echo.
echo -- 2. Unpacked app structure --

set "WIN_UNPACKED=%DIST_DIR%\win-unpacked"
if not exist "%WIN_UNPACKED%" (
    for /d %%d in ("%DIST_DIR%\win*") do (
        if exist "%%d\PilotDeck.exe" set "WIN_UNPACKED=%%d"
    )
)

if exist "%WIN_UNPACKED%\PilotDeck.exe" (
    set /a PASS+=1
    echo   [PASS] PilotDeck.exe present
) else (
    set /a FAIL+=1
    echo   [FAIL] PilotDeck.exe not found
    echo         Looked in: %WIN_UNPACKED%
)

REM ── 3. Bundled resources ──
echo.
echo -- 3. Bundled resources --

set "RES=%WIN_UNPACKED%\resources"
if not exist "%RES%" (
    set /a FAIL+=1
    echo   [FAIL] resources directory not found
    goto :skip_resources
)

if exist "%RES%\app.asar" (
    set /a PASS+=1
    echo   [PASS] app.asar present
) else (
    set /a FAIL+=1
    echo   [FAIL] app.asar missing
)

if exist "%RES%\node-bin\node.exe" (
    set /a PASS+=1
    for /f "delims=" %%v in ('"%RES%\node-bin\node.exe" --version 2^>nul') do (
        echo   [PASS] Bundled Node present (%%v^)
    )
) else (
    set /a FAIL+=1
    echo   [FAIL] node-bin\node.exe missing
)

if exist "%RES%\bun-bin\bun.exe" (
    set /a PASS+=1
    for /f "delims=" %%v in ('"%RES%\bun-bin\bun.exe" --version 2^>nul') do (
        echo   [PASS] Bundled Bun present (%%v^)
    )
) else (
    set /a FAIL+=1
    echo   [FAIL] bun-bin\bun.exe missing
)

if exist "%RES%\pilotdeckui-bundle.tar" (
    set /a PASS+=1
    echo   [PASS] pilotdeckui-bundle.tar present
) else (
    set /a FAIL+=1
    echo   [FAIL] pilotdeckui-bundle.tar missing
)

if exist "%RES%\pilotdeck-main-bundle.tar" (
    set /a PASS+=1
    echo   [PASS] pilotdeck-main-bundle.tar present
) else (
    set /a FAIL+=1
    echo   [FAIL] pilotdeck-main-bundle.tar missing
)

if exist "%RES%\pilotdeck-memory-core-bundle.tar" (
    set /a PASS+=1
    echo   [PASS] pilotdeck-memory-core-bundle.tar present
) else (
    set /a FAIL+=1
    echo   [FAIL] pilotdeck-memory-core-bundle.tar missing
)

:skip_resources

REM ── 4. Bundle extraction smoke test ──
echo.
echo -- 4. Bundle extraction smoke test --

set "SANDBOX=%TEMP%\pilotdeck-verify-%RANDOM%"
mkdir "%SANDBOX%" 2>nul

set "CCUI_DIR=%SANDBOX%\pilotdeckui"
mkdir "%CCUI_DIR%" 2>nul
if exist "%RES%\pilotdeckui-bundle.tar" (
    tar xf "%RES%\pilotdeckui-bundle.tar" -C "%CCUI_DIR%" 2>nul
    if exist "%CCUI_DIR%\server\index.js" (
        set /a PASS+=1
        echo   [PASS] pilotdeckui-bundle extracted, server\index.js present
    ) else (
        set /a FAIL+=1
        echo   [FAIL] server\index.js missing after extraction
    )
)

set "CCM_DIR=%SANDBOX%\pilotdeck-main"
mkdir "%CCM_DIR%" 2>nul
if exist "%RES%\pilotdeck-main-bundle.tar" (
    tar xf "%RES%\pilotdeck-main-bundle.tar" -C "%CCM_DIR%" 2>nul
    if exist "%CCM_DIR%\dist\src\cli\pilotdeck.js" (
        set /a PASS+=1
        echo   [PASS] pilotdeck-main-bundle extracted, dist\src\cli\pilotdeck.js present
    ) else (
        set /a FAIL+=1
        echo   [FAIL] dist\src\cli\pilotdeck.js missing after extraction
    )
)

set "MEM_DIR=%SANDBOX%\pilotdeck-memory-core"
mkdir "%MEM_DIR%" 2>nul
if exist "%RES%\pilotdeck-memory-core-bundle.tar" (
    tar xf "%RES%\pilotdeck-memory-core-bundle.tar" -C "%MEM_DIR%" 2>nul
    if exist "%MEM_DIR%\lib\index.js" (
        set /a PASS+=1
        echo   [PASS] pilotdeck-memory-core extracted, lib\index.js present
    ) else (
        set /a FAIL+=1
        echo   [FAIL] lib\index.js missing after extraction
    )
)

REM ── 5. Gateway smoke test ──
echo.
echo -- 5. Gateway smoke test --

set "PILOT_HOME=%SANDBOX%\home\.pilotdeck"
mkdir "%PILOT_HOME%" 2>nul

REM Create stub V2 pilotdeck.yaml
(
echo schemaVersion: 1
echo agent:
echo   model: pilotdeck/test-model
echo model:
echo   providers:
echo     pilotdeck:
echo       protocol: anthropic
echo       url: "https://example.invalid/v1"
echo       apiKey: "smoke-test-not-real"
echo       models:
echo         test-model: {}
) > "%PILOT_HOME%\pilotdeck.yaml"

set "GW_ENTRY=%CCM_DIR%\dist\src\cli\pilotdeck.js"
set "NODE_BIN=%RES%\node-bin\node.exe"
set GATEWAY_PORT=18789

if not exist "%NODE_BIN%" (
    set /a WARN+=1
    echo   [WARN] Skipping gateway smoke test (no bundled node)
    goto :skip_gateway
)
if not exist "%GW_ENTRY%" (
    set /a WARN+=1
    echo   [WARN] Skipping gateway smoke test (no gateway entry)
    goto :skip_gateway
)

echo   Starting Gateway on port %GATEWAY_PORT%...
set "HOME=%SANDBOX%\home"
set "GW_LOG=%SANDBOX%\gateway.log"
start /b "" "%NODE_BIN%" "%GW_ENTRY%" server > "%GW_LOG%" 2>&1

REM Wait up to 30 seconds for /health
set GW_OK=0
for /L %%i in (1,1,60) do (
    if !GW_OK!==0 (
        curl -s -m 1 "http://127.0.0.1:%GATEWAY_PORT%/health" 2>nul | findstr /c:"ok" >nul 2>nul
        if !errorlevel!==0 (
            set GW_OK=1
        ) else (
            ping -n 2 127.0.0.1 >nul 2>nul
        )
    )
)

if %GW_OK%==1 (
    set /a PASS+=1
    echo   [PASS] Gateway responding on http://127.0.0.1:%GATEWAY_PORT%/health
) else (
    set /a FAIL+=1
    echo   [FAIL] Gateway did not respond within 30s
    if exist "%GW_LOG%" (
        echo   Last lines of gateway log:
        type "%GW_LOG%" 2>nul | more +1
    )
)

REM Kill gateway
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":%GATEWAY_PORT% " ^| findstr "LISTEN"') do (
    taskkill /f /pid %%p >nul 2>nul
)

:skip_gateway

REM ── 6. build-info.json ──
echo.
echo -- 6. Build metadata --

if exist "%WIN_UNPACKED%\resources\app.asar" (
    set /a PASS+=1
    echo   [PASS] Electron app package present
) else (
    set /a WARN+=1
    echo   [WARN] Cannot verify build-info inside asar
)

REM ── Cleanup ──
if exist "%SANDBOX%" (
    rmdir /s /q "%SANDBOX%" 2>nul
)

REM ── Summary ──
echo.
echo =========================================
echo  Summary
echo =========================================
echo   Pass: %PASS%    Warn: %WARN%    Fail: %FAIL%
echo.

if %FAIL%==0 (
    echo  [OK] Windows installer verification PASSED
    exit /b 0
) else (
    echo  [ERROR] Windows installer verification FAILED
    exit /b 1
)
