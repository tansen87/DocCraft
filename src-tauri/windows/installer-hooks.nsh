; DocCraft NSIS installer hooks (docs/design/00020_update-check-and-install-layout.md §3.3).
;
; Two things are enforced here, both from inside `Section Install` where Tauri
; inserts `NSIS_HOOK_PREINSTALL` (right after the template's
; `SetOutPath $INSTDIR`, before any `File` command):
;
;   1. The install path is always normalised to `<chosen>\DocCraft`. Users may
;      pick any folder on the directory page; without the suffix a folder like
;      `D:\software` would become the install root, which (a) mixes unrelated
;      files into the app directory and (b) makes the blast radius of any
;      installer-driven $INSTDIR cleanup unbounded.
;   2. The target must be user-writable: system locations are refused *before*
;      anything is copied, because `installMode = currentUser` installs without
;      elevation and cannot request it (the installer would otherwise fail
;      halfway through).
;
; The normalisation is idempotent: on an upgrade/reinstall the template restores
; $INSTDIR from the registry (already ending in `\DocCraft`), so the suffix is
; only appended when it is really missing.
;
; Messages are intentionally ASCII-only: NSIS reads `!include`d files using the
; installer's code page, and non-ASCII text here would need a BOM-prefixed
; include to survive. Localising them would be a separate change.

!define DOCCRAFT_SUBDIR "DocCraft"

!macro NSIS_HOOK_PREINSTALL
  ; ── 1) normalise $INSTDIR to <chosen>\DocCraft ─────────────────────────────
  ; "\DocCraft" is 9 characters long.
  StrCpy $R0 "$INSTDIR" -9
  StrCmp $R0 "\${DOCCRAFT_SUBDIR}" doccraft_norm_done
    StrCpy $INSTDIR "$INSTDIR\${DOCCRAFT_SUBDIR}"
  doccraft_norm_done:

  ; The template already called SetOutPath with the pre-normalisation value and
  ; every following `File` command writes relative to the current output path,
  ; so it has to be re-pointed at the normalised directory.
  SetOutPath "$INSTDIR"

  ; ── 2) refuse locations that need elevation ───────────────────────────────
  ; Prefix comparison is case-insensitive (plain StrCmp), which matches
  ; Windows path semantics. The forced `\DocCraft` suffix is what makes a plain
  ; prefix test sufficient - the app never becomes the reserved folder itself.
  StrLen $R1 "$PROGRAMFILES"
  StrCpy $R2 "$INSTDIR" $R1
  StrCmp $R2 "$PROGRAMFILES" doccraft_blocked doccraft_chk_pf64
  doccraft_chk_pf64:
  StrLen $R1 "$PROGRAMFILES64"
  StrCpy $R2 "$INSTDIR" $R1
  StrCmp $R2 "$PROGRAMFILES64" doccraft_blocked doccraft_chk_windir
  doccraft_chk_windir:
  StrLen $R1 "$WINDIR"
  StrCpy $R2 "$INSTDIR" $R1
  StrCmp $R2 "$WINDIR" doccraft_blocked doccraft_chk_programdata
  doccraft_chk_programdata:
  StrLen $R1 "$PROGRAMDATA"
  StrCpy $R2 "$INSTDIR" $R1
  StrCmp $R2 "$PROGRAMDATA" doccraft_blocked doccraft_guards_done

  doccraft_blocked:
    MessageBox MB_ICONSTOP \
      "DocCraft cannot be installed here:$\r$\n$INSTDIR$\r$\n$\r$\nThis location is reserved by Windows and needs administrator rights.$\r$\nChoose a folder inside your user profile (or another drive) - DocCraft always installs into a 'DocCraft' sub-folder of the path you pick, and never needs administrator rights."
    SetErrorLevel 1
    Quit

  doccraft_guards_done:

  ; ── 3) verify the target is writable ─────────────────────────────────────
  ; `SetOutPath` above created the directory, so a failed FileOpen means the
  ; folder exists but cannot be written to (read-only mount, permissions, ...).
  ClearErrors
  FileOpen $R1 "$INSTDIR\.doccraft-write-test" w
  IfErrors 0 doccraft_probe_ok
    MessageBox MB_ICONSTOP \
      "DocCraft cannot write to:$\r$\n$INSTDIR$\r$\n$\r$\nPick a different folder - the application stores its models and settings next to the executable."
    SetErrorLevel 1
    Quit
  doccraft_probe_ok:
  FileWrite $R1 "ok"
  FileClose $R1
  Delete "$INSTDIR\.doccraft-write-test"
!macroend

; Nothing to do: the application-side migration
; (core::migrate::migrate_once) owns the legacy `doccraft_resources` -> flat
; layout move, because it can run on every launch, retry safely and log.
!macro NSIS_HOOK_POSTINSTALL
!macroend
