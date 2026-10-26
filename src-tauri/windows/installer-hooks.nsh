; DocCraft NSIS installer hooks (docs/design/00020_update-check-and-install-layout.md §3.3).
;
; Three things are enforced here, all from inside `Section Install` where Tauri
; inserts `NSIS_HOOK_PREINSTALL` (right after the template's
; `SetOutPath $INSTDIR`, before any `File` command):
;
;   1. The install path is always normalised to `<chosen>\DocCraft`. Users may
;      pick any folder on the directory page; without the suffix a folder like
;      `D:\software` would become the install root, which (a) mixes unrelated
;      files into the app directory and (b) makes the blast radius of any
;      installer-driven $INSTDIR cleanup unbounded.
;   2. Legacy nested installs (`<chosen>\DocCraft\DocCraft`, produced by the
;      broken normalisation shipped up to v0.3.1) are folded back one level, so
;      an already-nested install does not stay nested forever. Settings and
;      models are moved up first; when they cannot be moved the fold is
;      abandoned and the update continues in place.
;   3. The target must be user-writable: system locations are refused *before*
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
!define DOCCRAFT_DATA_DIR "data"
!define DOCCRAFT_MODELS_DIR "models"

; 1 when the pre-install hook folded at least one legacy `\DocCraft` level; the
; post-install hook then repoints the shortcuts and deletes the old folders.
Var DocCraftCollapsed

; Sets $R1 to 1 when the path in $R0 has the sub-folder name as its last
; component, 0 otherwise. A plain `StrCpy ... "" -9` comparison is not enough:
; for short paths such as `C:\DocCraft` the last nine characters are
; `:\DocCraft`, so the separator would be missed and the suffix appended again.
; The separator is therefore checked on its own. `StrCmp` is case-insensitive,
; which is what Windows path semantics want.
Function DocCraftPathEndsWithSubdir
  StrCpy $R1 0
  StrLen $R2 "$R0"
  IntCmp $R2 9 doccraft_ends_check doccraft_ends_no doccraft_ends_check

  doccraft_ends_check:
  StrCpy $R3 "$R0" "" -8
  StrCmp $R3 "${DOCCRAFT_SUBDIR}" 0 doccraft_ends_no
  StrCpy $R3 "$R0" 1 -9
  StrCmp $R3 "\" 0 doccraft_ends_no
  StrCpy $R1 1

  doccraft_ends_no:
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; ── 0) drop trailing separators ────────────────────────────────────────────
  ; `$INSTDIR` is normally already clean, but a stale registry value or a
  ; `/D=` with a trailing "\" would defeat every suffix comparison below.
  doccraft_trim_check:
  StrCpy $R0 "$INSTDIR" "" -1
  StrCmp $R0 "\" 0 doccraft_trim_done
    StrCpy $INSTDIR "$INSTDIR" -1
    Goto doccraft_trim_check
  doccraft_trim_done:

  ; ── 1) fold legacy nested installs back one level ──────────────────────────
  ; v0.3.1 and older appended `\DocCraft` on every run, leaving
  ; `<chosen>\DocCraft\DocCraft`. Without this step the suffix check in (2)
  ; keeps such an install inside the inner folder forever. `data` (settings +
  ; DPAPI key) and `models` are renamed up first: if either move fails (running
  ; app, ACLs) the fold is abandoned and the update continues in place - an
  ; ugly path is harmless, losing the settings is not.
  StrCpy $DocCraftCollapsed 0
  doccraft_collapse_check:
    StrCpy $R0 "$INSTDIR"
    Call DocCraftPathEndsWithSubdir
    StrCmp $R1 1 0 doccraft_collapse_done
    StrCpy $R4 "$INSTDIR" -9
    StrCpy $R0 "$R4"
    Call DocCraftPathEndsWithSubdir
    StrCmp $R1 1 0 doccraft_collapse_done

    StrCpy $R2 0
    IfFileExists "$INSTDIR\${DOCCRAFT_DATA_DIR}\*.*" 0 doccraft_collapse_models
      IfFileExists "$R4\${DOCCRAFT_DATA_DIR}\*.*" doccraft_collapse_abandon
      ClearErrors
      Rename "$INSTDIR\${DOCCRAFT_DATA_DIR}" "$R4\${DOCCRAFT_DATA_DIR}"
      IfErrors doccraft_collapse_abandon
      StrCpy $R2 1

    doccraft_collapse_models:
    IfFileExists "$INSTDIR\${DOCCRAFT_MODELS_DIR}\*.*" 0 doccraft_collapse_apply
      IfFileExists "$R4\${DOCCRAFT_MODELS_DIR}\*.*" doccraft_collapse_revert
      ClearErrors
      Rename "$INSTDIR\${DOCCRAFT_MODELS_DIR}" "$R4\${DOCCRAFT_MODELS_DIR}"
      IfErrors doccraft_collapse_revert
    Goto doccraft_collapse_apply

    doccraft_collapse_revert:
      ; put the settings back so an in-place update keeps using them
      StrCmp $R2 1 0 doccraft_collapse_abandon
        ClearErrors
        Rename "$R4\${DOCCRAFT_DATA_DIR}" "$INSTDIR\${DOCCRAFT_DATA_DIR}"
      Goto doccraft_collapse_abandon

    doccraft_collapse_apply:
      StrCpy $INSTDIR "$R4"
      StrCpy $DocCraftCollapsed 1
      Goto doccraft_collapse_check

    doccraft_collapse_abandon:
  doccraft_collapse_done:

  ; ── 2) normalise $INSTDIR to <chosen>\DocCraft ─────────────────────────────
  StrCpy $R0 "$INSTDIR"
  Call DocCraftPathEndsWithSubdir
  StrCmp $R1 1 doccraft_norm_done
    StrCpy $INSTDIR "$INSTDIR\${DOCCRAFT_SUBDIR}"
  doccraft_norm_done:

  ; The template already called SetOutPath with the pre-normalisation value and
  ; every following `File` command writes relative to the current output path,
  ; so it has to be re-pointed at the normalised directory.
  SetOutPath "$INSTDIR"

  ; ── 3) refuse locations that need elevation ───────────────────────────────
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

  ; ── 4) verify the target is writable ─────────────────────────────────────
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

!macro NSIS_HOOK_POSTINSTALL
  StrCmp $DocCraftCollapsed 1 0 doccraft_post_done

  ; ── 5) repoint shortcuts left by the nested install ───────────────────────
  ; `/UPDATE` never recreates shortcuts, so the ones created by the original
  ; (nested) install would keep pointing into the folder deleted below.
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 doccraft_post_desktop_done
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  doccraft_post_desktop_done:

  IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" 0 doccraft_post_start_done
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  doccraft_post_start_done:

  ; ── 6) remove the legacy folders ──────────────────────────────────────────
  ; Every old level lives under the new install directory; `data` and `models`
  ; were already moved out in the pre-install hook.
  RMDir /r "$INSTDIR\${DOCCRAFT_SUBDIR}"

  doccraft_post_done:
!macroend

; The legacy `doccraft_resources` -> flat layout move is *not* done here: the
; application-side migration (core::migrate::migrate_once) owns it, because it
; can run on every launch, retry safely and log.
