@echo off
node "%~dp0bin\cah.js" reinstall %*
exit /b %errorlevel%
