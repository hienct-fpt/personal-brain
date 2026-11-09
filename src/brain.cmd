@echo off
rem Personal Brain CLI
rem   brain                      start dashboard (http://localhost:4377) and open browser
rem   brain ingest [--full]      read new Claude Code transcripts into brain.db
rem   brain summarize "<proj>"   AI summary of one project (needs API key in Settings)
rem   brain version              show installed version
setlocal
set "D=%~dp0"
if /i "%~1"=="ingest" ( node --no-warnings "%D%ingest.mjs" %2 & goto :eof )
if /i "%~1"=="summarize" ( node --no-warnings "%D%summarize.mjs" %2 & goto :eof )
if /i "%~1"=="version" ( type "%D%version.json" & goto :eof )
node --no-warnings "%D%server.mjs" --open
