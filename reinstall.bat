@echo off
cd /d "%~dp0"
node bin\cah.js uninstall %* || exit /b %errorlevel%
node bin\cah.js install %*
