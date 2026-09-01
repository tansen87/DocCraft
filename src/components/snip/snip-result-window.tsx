import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition, primaryMonitor } from "@tauri-apps/api/window";
import { Check, Copy, Pin, PinOff, X } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format-duration";
import { getAppSettings } from "@/lib/ipc";

const WINDOW_LABEL = "snip-result";

/** localStorage stash so a freshly created window has the content on first paint. */
export const SNIP_RESULT_KEY = "doccraft-snip-result";

/** localStorage stash of the recognition duration (ms, empty when unknown). */
const SNIP_RESULT_DURATION_KEY = "doccraft-snip-result-duration";

/** localStorage stash of the local-OCR confidence (0..1, empty when unknown). */
const SNIP_RESULT_CONFIDENCE_KEY = "doccraft-snip-result-confidence";

/** Payload pushed to an already-open result window. */
interface SnipResultPayload {
  markdown: string;
  durationMs?: number;
  ocrConfidence?: number | null;
}

/** localStorage stash of the last user-chosen window position (physical px). */
const SNIP_RESULT_POS_KEY = "doccraft-snip-result-pos";

/** Padding from the primary monitor edges for the default position. */
const DEFAULT_EDGE_PADDING = 20;
/** The default bottom-right spot sits this much higher than the very bottom. */
const DEFAULT_LIFT_PX = 90;

/**
 * While set (ms timestamp), move events are treated as programmatic
 * placement and not persisted as the user's chosen position.
 */
let suppressMoveSaveUntil = 0;

function readSavedPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(SNIP_RESULT_POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
    return typeof p?.x === "number" && typeof p?.y === "number"
      ? { x: p.x, y: p.y }
      : null;
  } catch {
    return null;
  }
}

/**
 * Place the window at its last remembered position, falling back to a
 * lifted bottom-right default when nothing has been saved yet. The saved
 * position is clamped so the window always stays fully on the primary
 * monitor (e.g. after a monitor was unplugged or resolution changed).
 */
async function placeAtRememberedOrDefault(win: WebviewWindow) {
  try {
    const size = await win.outerSize();
    const monitor = await primaryMonitor();
    const saved = readSavedPos();
    if (saved && monitor) {
      const x = Math.min(
        Math.max(saved.x, 0),
        Math.max(0, monitor.size.width - size.width),
      );
      const y = Math.min(
        Math.max(saved.y, 0),
        Math.max(0, monitor.size.height - size.height),
      );
      suppressMoveSaveUntil = Date.now() + 500;
      await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
      return;
    }
    if (monitor) {
      const x = Math.max(
        0,
        monitor.size.width - size.width - DEFAULT_EDGE_PADDING,
      );
      const y = Math.max(
        0,
        monitor.size.height -
          size.height -
          DEFAULT_EDGE_PADDING -
          DEFAULT_LIFT_PX,
      );
      suppressMoveSaveUntil = Date.now() + 500;
      await win.setPosition(new PhysicalPosition(x, y));
    }
  } catch {
    /* ignore */
  }
}

/**
 * Open (or reuse) the standalone screenshot-result window and show `markdown`
 * in it. Called from the main window after a successful snip recognition.
 *
 * The window always reveals *itself* (on mount, and whenever a
 * `snip:result` event arrives) - the main window deliberately never touches
 * the window handle, because `WebviewWindow.getByLabel` loses track of
 * windows after a dev-page reload and would mis-route into a duplicate
 * label creation.
 */
export async function showSnipResultWindow(
  markdown: string,
  durationMs?: number,
  ocrConfidence?: number | null,
): Promise<void> {
  localStorage.setItem(SNIP_RESULT_KEY, markdown);
  localStorage.setItem(
    SNIP_RESULT_DURATION_KEY,
    durationMs != null ? String(durationMs) : "",
  );
  localStorage.setItem(
    SNIP_RESULT_CONFIDENCE_KEY,
    ocrConfidence != null ? String(ocrConfidence) : "",
  );

  const notify = () =>
    emitTo(WINDOW_LABEL, "snip:result", {
      markdown,
      durationMs,
      ocrConfidence,
    } satisfies SnipResultPayload).catch(() => {});

  const existing = await WebviewWindow.getByLabel(WINDOW_LABEL).catch(
    () => null,
  );
  if (existing) {
    await placeAtRememberedOrDefault(existing);
    await notify();
    return;
  }

  try {
    const win = new WebviewWindow(WINDOW_LABEL, {
      url: "index.html",
      title: "DocCraft",
      width: 360,
      height: 260,
      minWidth: 260,
      minHeight: 200,
      decorations: false,
      resizable: true,
      visible: false,
      transparent: true,
      shadow: false,
    });
    await new Promise<void>((resolve, reject) => {
      void win.once("tauri://created", () => resolve());
      void win.once("tauri://error", (e) =>
        reject(new Error(String(e.payload))),
      );
    });
    // Explicitly remove decorations and shadow so the window is truly frameless.
    await win.setDecorations(false).catch(() => {});
    await win.setShadow(false).catch(() => {});
    await placeAtRememberedOrDefault(win);
  } catch {
    // The window already exists (e.g. stale metadata after a reload) -
    // pushing the event is enough; it will reveal itself.
    await notify();
  }
}

/**
 * Content of the standalone screenshot-result window (routed in main.tsx by
 * webview label `snip-result`). A small frameless, freely draggable window:
 * the header doubles as the drag region and carries pin-on-top, copy and
 * clear buttons; the body renders the recognized markdown.
 */
export function SnipResultWindow() {
  const { t } = useI18n();
  // Lazy init from the stash: the main window writes it before creating /
  // reusing this window, so the first paint already has the latest text.
  const [markdown, setMarkdown] = useState<string>(
    () => localStorage.getItem(SNIP_RESULT_KEY) ?? "",
  );
  const [durationMs, setDurationMs] = useState<number | null>(() => {
    const raw = localStorage.getItem(SNIP_RESULT_DURATION_KEY);
    return raw ? Number(raw) || null : null;
  });
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(() => {
    const raw = localStorage.getItem(SNIP_RESULT_CONFIDENCE_KEY);
    return raw ? Number(raw) || null : null;
  });
  const [pinned, setPinned] = useState(false);
  const [copied, setCopied] = useState(false);
  const [glassOpacity, setGlassOpacity] = useState(60);
  const [glassBlurEnabled, setGlassBlurEnabled] = useState(true);
  // Tooltip open state for each button - closed on pointer-down so dragging
  // the header never leaves a stale tooltip visible.
  const [pinTipOpen, setPinTipOpen] = useState(false);
  const [copyTipOpen, setCopyTipOpen] = useState(false);
  const [clearTipOpen, setClearTipOpen] = useState(false);

  // The window is created invisible; reveal once mounted (content painted).
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    void win
      .show()
      .then(() => win.setFocus())
      .catch(() => {});
  }, []);

  // Load the glassmorphism opacity/blur settings.
  useEffect(() => {
    getAppSettings()
      .then((s) => {
        setGlassOpacity(s.snipResultOpacity ?? 60);
        setGlassBlurEnabled(s.glassBlurEnabled ?? true);
      })
      .catch(() => {});
  }, []);

  // Make body and html transparent so glassmorphism and rounded corners show through.
  useEffect(() => {
    document.body.style.backgroundColor = "transparent";
    document.documentElement.style.backgroundColor = "transparent";
    // Force #root to be transparent as well via a style tag.
    const style = document.createElement("style");
    style.id = "snip-result-bg";
    style.textContent = `#root { background: transparent !important; }`;
    document.head.appendChild(style);
    return () => {
      const el = document.getElementById("snip-result-bg");
      if (el) el.remove();
    };
  }, []);

  // Remember the user-chosen window position: persist it (debounced) after
  // every move, except while a programmatic placement is in flight. The next
  // recognition restores the last position instead of the default spot.
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | null = null;
    void win
      .onMoved(() => {
        if (Date.now() < suppressMoveSaveUntil) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          void win
            .outerPosition()
            .then((p) =>
              localStorage.setItem(
                SNIP_RESULT_POS_KEY,
                JSON.stringify({ x: p.x, y: p.y }),
              ),
            )
            .catch(() => {});
        }, 300);
      })
      .then((f) => {
        unlisten = f;
      })
      .catch(() => {});
    return () => {
      clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  /** Reveal + focus this window (used on mount and on new content). */
  function reveal() {
    const win = getCurrentWebviewWindow();
    void win
      .show()
      .then(() => win.setFocus())
      .catch(() => {});
  }

  /** Reload glass opacity and blur from backend settings. */
  function reloadOpacity() {
    getAppSettings()
      .then((s) => {
        setGlassOpacity(s.snipResultOpacity ?? 60);
        setGlassBlurEnabled(s.glassBlurEnabled ?? true);
      })
      .catch(() => {});
  }

  // Live updates when the window is reused for a new screenshot. The main
  // window only pushes the text - showing is our own job, so a stale handle
  // on either side can never leave the window hidden.
  useEffect(() => {
    const unlisten = listen<SnipResultPayload>("snip:result", (e) => {
      setMarkdown(e.payload.markdown);
      setDurationMs(
        typeof e.payload.durationMs === "number" ? e.payload.durationMs : null,
      );
      setOcrConfidence(
        typeof e.payload.ocrConfidence === "number"
          ? e.payload.ocrConfidence
          : null,
      );
      setCopied(false);
      reloadOpacity();
      reveal();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Real-time opacity/blur update when settings are saved in the main window.
  useEffect(() => {
    const unlisten = listen<{ opacity?: number; blur?: boolean }>(
      "snip:settings-changed",
      (e) => {
        const live =
          typeof e.payload?.opacity === "number" ||
          typeof e.payload?.blur === "boolean";
        if (live) {
          // Live preview: use the values sent directly from the sliders.
          if (typeof e.payload?.opacity === "number") {
            setGlassOpacity(e.payload.opacity);
          }
          if (typeof e.payload?.blur === "boolean") {
            setGlassBlurEnabled(e.payload.blur);
          }
        } else {
          // Saved: reload from backend.
          reloadOpacity();
        }
      },
    );
    // Fallback: poll settings every 2 s in case the event is missed
    // (e.g. the window was not yet open when settings were saved).
    const timer = setInterval(reloadOpacity, 2000);
    return () => {
      void unlisten.then((f) => f());
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function togglePin() {
    const next = !pinned;
    setPinned(next);
    try {
      await getCurrentWebviewWindow().setAlwaysOnTop(next);
    } catch {
      /* window control unavailable - keep the toggle visual only */
    }
  }

  async function copy() {
    if (!markdown) return;
    try {
      const { writeText } =
        await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  /** Hide the window (kept alive for cheap reuse by the next screenshot). */
  function clear() {
    void getCurrentWebviewWindow()
      .hide()
      .catch(() => {});
  }

  return (
    <div
      className="h-screen w-screen overflow-hidden"
      style={{ clipPath: "inset(0 round 0.75rem)" }}
    >
      <div
        className="relative flex h-full w-full flex-col text-foreground"
        style={{
          backgroundColor: `color-mix(in srgb, var(--background) ${glassOpacity}%, transparent)`,
          backdropFilter: glassBlurEnabled ? "blur(20px)" : "none",
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-50 rounded-xl border border-border/30"
        />

        {/* Header(拖拽区域) */}
        <div
          data-tauri-drag-region
          onPointerDown={() => {
            setPinTipOpen(false);
            setCopyTipOpen(false);
            setClearTipOpen(false);
          }}
          className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/30 bg-white/[0.03] pl-3 pr-1.5 transition-colors hover:bg-green-500/15"
        >
          <div
            data-tauri-drag-region
            className="flex min-w-0 items-center gap-2 select-none"
          >
            <span
              data-tauri-drag-region
              className="truncate text-xs font-semibold tracking-wider text-muted-foreground"
            >
              DocCraft
            </span>
            {durationMs != null ? (
              <span
                data-tauri-drag-region
                className="shrink-0 rounded-full bg-muted/70 px-1.5 py-0.5 text-xs leading-none tabular-nums text-muted-foreground"
              >
                {formatDuration(durationMs)}
              </span>
            ) : null}
            {ocrConfidence != null ? (
              <span
                data-tauri-drag-region
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-0.5 text-xs leading-none tabular-nums",
                  ocrConfidence < 0.5
                    ? "bg-destructive/15 text-destructive"
                    : ocrConfidence < 0.7
                      ? "bg-warning/15 text-warning"
                      : "bg-success/15 text-success",
                )}
              >
                {Math.round(ocrConfidence * 100)}%
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip open={pinTipOpen} onOpenChange={setPinTipOpen}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void togglePin()}
                  className={cn(pinned && "text-primary")}
                >
                  {pinned ? <PinOff /> : <Pin />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {pinned ? t("snip.unpin") : t("snip.pin")}
              </TooltipContent>
            </Tooltip>
            <Tooltip open={copyTipOpen} onOpenChange={setCopyTipOpen}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!markdown}
                  onClick={() => void copy()}
                >
                  {copied ? <Check className="text-emerald-500" /> : <Copy />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("tooltip.copy")}</TooltipContent>
            </Tooltip>
            <Tooltip open={clearTipOpen} onOpenChange={setClearTipOpen}>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={clear}>
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("snip.close")}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 whitespace-pre-wrap break-words px-4 py-3 font-mono text-[13px] leading-relaxed">
            {markdown}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
