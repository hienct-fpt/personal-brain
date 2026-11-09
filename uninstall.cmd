@echo off
rem Uninstall Personal Brain. Options: --dir ^<path^> --purge --dry-run
node "%~dp0scripts\uninstall.mjs" %*
