@echo off
rem Install / upgrade Personal Brain. Options: --dir ^<path^> --retention ^<days^> --no-hook --no-shim --no-ingest --dry-run
where node >nul 2>nul || ( echo Can Node.js ^>= 22.5 - tai tai https://nodejs.org & exit /b 1 )
node "%~dp0scripts\install.mjs" %*
