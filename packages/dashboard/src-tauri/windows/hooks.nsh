; Nexus NSIS installer hooks
; Kill running Nexus processes before install/uninstall so files aren't locked.

!macro NSIS_HOOK_PREINSTALL
  ; Kill the sidecar server
  nsExec::ExecToLog 'taskkill /F /IM nexus-server.exe'
  ; Kill the desktop app
  nsExec::ExecToLog 'taskkill /F /IM Nexus.exe'
  nsExec::ExecToLog 'taskkill /F /IM nexus-desktop.exe'
  ; Brief pause to let OS release file handles
  Sleep 1000
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /IM nexus-server.exe'
  nsExec::ExecToLog 'taskkill /F /IM Nexus.exe'
  nsExec::ExecToLog 'taskkill /F /IM nexus-desktop.exe'
  Sleep 1000
!macroend
