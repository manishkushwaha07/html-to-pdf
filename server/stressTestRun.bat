@echo off

:START
cls
set /p iterations="Enter number of requests: "
echo Running stress test with %iterations% requests...
node stressTest.js %iterations%


:ASK
echo.
set /p choice="Do you want to run again? (Y/N): "
if /i "%choice%"=="Y" goto START
if /i "%choice%"=="N" goto END
echo Invalid choice. Please enter Y or N.
goto ASK

:END
echo Exiting...
pause