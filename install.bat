@echo off
node "%~dp0bin\cah.js" install %*
exit /b %errorlevel%
