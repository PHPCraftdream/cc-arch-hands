@echo off
node "%~dp0bin\cah.js" uninstall %*
exit /b %errorlevel%
