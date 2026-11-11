@echo off
rem Personal Brain CLI
rem   brain                      start dashboard in this window (http://localhost:4377) and open browser
rem   brain start                run the dashboard in the background (log: server.log)
rem   brain stop | restart       stop / restart the background (or windowed) server
rem   brain status               running? which version? autostart?
rem   brain autostart on|off     start in the background at Windows logon
rem   brain ingest [--full]      read new Claude Code transcripts into brain.db
rem   brain summarize "<proj>"   AI summary of one project (needs API key in Settings)
rem   brain version              show installed version
rem   brain kit [add|remove] ...  sample skills/agents/commands → <project>\.claude (brain kit = list)
setlocal
set "D=%~dp0"
if /i "%~1"=="ingest" ( node --no-warnings "%D%ingest.mjs" %2 & goto :eof )
if /i "%~1"=="summarize" ( node --no-warnings "%D%summarize.mjs" %2 & goto :eof )
if /i "%~1"=="kit" ( node --no-warnings "%D%kit.mjs" %* & goto :eof )
if /i "%~1"=="version" ( type "%D%version.json" & goto :eof )
for %%c in (start stop restart status autostart) do if /i "%~1"=="%%c" ( node --no-warnings "%D%service.mjs" %* & goto :eof )
node --no-warnings "%D%server.mjs" --open
