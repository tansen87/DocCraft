import { useCallback, useEffect, useRef, useState } from "react";
import type { SetStateAction } from "react";
import {
  Camera,
  Cpu,
  Database,
  Eye,
  EyeOff,
  FileSpreadsheet,
  KeyRound,
  Loader2,
  Minimize2,
  Plus,
  Save,
  ScanText,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { OcrMode } from "@/lib/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getAppSettings,
  getOcrConfig,
  revealOcrKey,
  saveOcrConfig,
  setAppSettings,
} from "@/lib/ipc";
import { setMaxConcurrent as applyRuntimeConcurrency } from "@/lib/concurrency";
import { useI18n } from "@/i18n";
import type {
  AppSettings,
  OcrModel,
  OcrVendor,
  OcrVendorInput,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type SettingsSection = "ocr" | "threads" | "snip" | "tray" | "cache" | "excel";

const SECTIONS: {
  id: SettingsSection;
  labelKey:
    | "settings.ocr"
    | "settings.threads"
    | "snip.capture"
    | "settings.tray"
    | "settings.cache"
    | "settings.excel";
  icon: typeof ScanText;
}[] = [
  {
    id: "ocr",
    labelKey: "settings.ocr",
    icon: ScanText,
  },
  {
    id: "threads",
    labelKey: "settings.threads",
    icon: Cpu,
  },
  {
    id: "snip",
    labelKey: "snip.capture",
    icon: Camera,
  },
  {
    id: "tray",
    labelKey: "settings.tray",
    icon: Minimize2,
  },
  {
    id: "cache",
    labelKey: "settings.cache",
    icon: Database,
  },
  {
    id: "excel",
    labelKey: "settings.excel",
    icon: FileSpreadsheet,
  },
];

interface VendorForm {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeySet: boolean;
  clearApiKey: boolean;
  showKey: boolean;
  models: OcrModel[];
}

function toForm(v: OcrVendor): VendorForm {
  return {
    id: v.id,
    name: v.name,
    baseUrl: v.baseUrl,
    apiKey: "",
    apiKeySet: v.apiKeySet,
    clearApiKey: false,
    showKey: false,
    models: v.models,
  };
}

export function SettingsView() {
  const { t } = useI18n();
  const [section, setSection] = useState<SettingsSection>("ocr");
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<SettingsSection | null>(null);
  const [vendors, setVendors] = useState<VendorForm[]>([]);
  const [ocrMode, setOcrMode] = useState<OcrMode>("disabled");
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [cacheExtracted, setCacheExtracted] = useState(true);
  const [excelTablesOnly, setExcelTablesOnly] = useState(true);
  const [screenshotHotkey, setScreenshotHotkey] = useState("");
  const [enableTray, setEnableTray] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getOcrConfig(), getAppSettings()])
      .then(([ocrVendors, settings]) => {
        if (cancelled) return;
        setVendors(ocrVendors.map(toForm));
        setOcrMode(settings.ocrMode);
        setMaxConcurrent(clampThread(settings.maxConcurrent));
        setCacheExtracted(settings.cacheExtractedText);
        setExcelTablesOnly(settings.excelTablesOnly);
        setScreenshotHotkey(settings.screenshotHotkey ?? "");
        setEnableTray(settings.enableTray);
        setLoaded(true);
      })
      .catch((e) =>
        toast.error(t("toast.loadSettingsFailed"), { description: String(e) }),
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const markDirty = () => {
    if (loaded) setDirty(true);
  };

  async function handleSave() {
    setSaving(true);
    const entries = vendors.map((v) => {
      const input: OcrVendorInput = {
        id: v.id,
        name: v.name.trim(),
        baseUrl: v.baseUrl.trim(),
        apiKey: v.apiKey,
        clearApiKey: v.clearApiKey,
        models: v.models
          .map((m) => ({ ...m, name: m.name.trim() }))
          .filter((m) => m.name.length > 0),
      };
      return {
        input,
        apiKeySet: !v.clearApiKey && (v.apiKey.length > 0 || v.apiKeySet),
      };
    });
    const settings: AppSettings = {
      maxConcurrent: clampThread(
        Number.isFinite(maxConcurrent) ? maxConcurrent : 1,
      ),
      cacheExtractedText: cacheExtracted,
      excelTablesOnly,
      ocrMode,
      screenshotHotkey: screenshotHotkey.trim() || null,
      enableTray,
    };
    try {
      await Promise.all([
        setAppSettings(settings),
        saveOcrConfig(entries.map((e) => e.input)),
      ]);
      setMaxConcurrent(settings.maxConcurrent);
      applyRuntimeConcurrency(settings.maxConcurrent);
      setVendors(
        entries.map((e) => ({
          id: e.input.id,
          name: e.input.name,
          baseUrl: e.input.baseUrl,
          apiKey: "",
          apiKeySet: e.apiKeySet,
          clearApiKey: false,
          showKey: false,
          models: e.input.models,
        })),
      );
      setDirty(false);
      toast.success(t("toast.configSaved"));
    } catch (e) {
      toast.error(t("toast.saveFailed"), { description: String(e) });
    } finally {
      setSaving(false);
    }
  }

  function scrollAreaViewport(): HTMLElement | null {
    return (
      containerRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      ) ?? null
    );
  }

  useEffect(() => {
    const vp = scrollAreaViewport();
    if (!vp) return;
    const viewport: HTMLElement = vp;
    const containerEl = containerRef.current;

    function updateActive() {
      // After a click the chosen section stays pinned until the user scrolls
      // manually; otherwise the smooth-scroll animation would re-pick a
      // different section mid-flight.
      if (pinnedRef.current) return;
      if (viewport.clientHeight === 0) return;
      const vpRect = viewport.getBoundingClientRect();
      // Reference line at 25% below the top of the scroll viewport; the active
      // section is the last one whose top edge has passed above it.
      const line = vpRect.top + viewport.clientHeight * 0.25;
      let active: SettingsSection = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = document.getElementById(`settings-${s.id}`);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= line) active = s.id;
      }
      // When the viewport is scrolled to the very bottom, a short last section
      // may never cross the line �?fall back to the last section.
      if (
        viewport.scrollTop + viewport.clientHeight >=
        viewport.scrollHeight - 1
      ) {
        active = SECTIONS[SECTIONS.length - 1].id;
      }
      setSection(active);
    }

    function beginUserScroll() {
      pinnedRef.current = null;
    }

    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-slot="scroll-area-scrollbar"]')) {
        beginUserScroll();
      }
    }

    updateActive();
    viewport.addEventListener("scroll", updateActive, { passive: true });
    window.addEventListener("resize", updateActive);
    const resizeObserver = new ResizeObserver(updateActive);
    resizeObserver.observe(viewport);
    containerEl?.addEventListener("wheel", beginUserScroll, { passive: true });
    containerEl?.addEventListener("touchstart", beginUserScroll, {
      passive: true,
    });
    containerEl?.addEventListener("pointerdown", onPointerDown);
    return () => {
      viewport.removeEventListener("scroll", updateActive);
      window.removeEventListener("resize", updateActive);
      resizeObserver.disconnect();
      containerEl?.removeEventListener("wheel", beginUserScroll);
      containerEl?.removeEventListener("touchstart", beginUserScroll);
      containerEl?.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  function jumpTo(id: SettingsSection) {
    pinnedRef.current = id;
    setSection(id);
    const vp = scrollAreaViewport();
    const el = document.getElementById(`settings-${id}`);
    if (vp && el) {
      const top =
        el.getBoundingClientRect().top -
        vp.getBoundingClientRect().top +
        vp.scrollTop;
      vp.scrollTo({ top: Math.max(top - 12, 0), behavior: "smooth" });
    }
  }

  return (
    <div
      ref={containerRef}
      className="mx-auto flex w-full max-w-5xl min-h-0 flex-1 gap-3"
    >
      <aside className="flex shrink-0 flex-col gap-1.5 md:w-56">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const active = section === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => jumpTo(s.id)}
              className={cn(
                "relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                active
                  ? "bg-muted/40 text-foreground before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-5 before:w-1 before:rounded-full before:bg-muted-foreground/80"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {t(s.labelKey)}
                </span>
              </span>
            </button>
          );
        })}
      </aside>

      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <ScrollArea className="min-h-0 flex-1">
          <div className="pb-4 pr-3">
            <div className="space-y-8">
              <section id="settings-ocr" className="scroll-mt-3">
                <SectionHeader icon={ScanText} title={t("settings.ocr")} />
                <OcrSettingsPanel
                  vendors={vendors}
                  onChange={(updater) => {
                    setVendors(updater);
                    markDirty();
                  }}
                  ocrMode={ocrMode}
                  onOcrModeChange={(v) => {
                    setOcrMode(v);
                    markDirty();
                  }}
                  loading={loading}
                />
              </section>
              <section id="settings-threads" className="scroll-mt-3">
                <SectionHeader icon={Cpu} title={t("settings.threads")} />
                <ThreadSettingsPanel
                  value={maxConcurrent}
                  onChange={(n) => {
                    setMaxConcurrent(n);
                    markDirty();
                  }}
                  disabled={loading}
                />
              </section>
              <section id="settings-snip" className="scroll-mt-3">
                <SectionHeader icon={Camera} title={t("snip.capture")} />
                <SnipSettingsPanel
                  value={screenshotHotkey}
                  onChange={(v) => {
                    setScreenshotHotkey(v);
                    markDirty();
                  }}
                  disabled={loading}
                />
              </section>
              <section id="settings-tray" className="scroll-mt-3">
                <SectionHeader icon={Minimize2} title={t("settings.tray")} />
                <TraySettingsPanel
                  value={enableTray}
                  onChange={(v) => {
                    setEnableTray(v);
                    markDirty();
                  }}
                  disabled={loading}
                />
              </section>
              <section id="settings-cache" className="scroll-mt-3">
                <SectionHeader icon={Database} title={t("settings.cache")} />
                <CacheSettingsPanel
                  value={cacheExtracted}
                  onChange={(v) => {
                    setCacheExtracted(v);
                    markDirty();
                  }}
                  disabled={loading}
                />
              </section>
              <section id="settings-excel" className="scroll-mt-3">
                <SectionHeader
                  icon={FileSpreadsheet}
                  title={t("settings.excel")}
                />
                <ExcelSettingsPanel
                  value={excelTablesOnly}
                  onChange={(v) => {
                    setExcelTablesOnly(v);
                    markDirty();
                  }}
                  disabled={loading}
                />
              </section>
            </div>
          </div>
        </ScrollArea>

        {dirty ? (
          <div className="flex shrink-0 items-center justify-between gap-3 rounded-xl border bg-card px-4 py-2.5 shadow-sm">
            <span className="text-xs text-muted-foreground">
              {t("settings.unsavedChanges")}
            </span>
            <Button
              onClick={handleSave}
              disabled={saving || !loaded}
              variant="secondary"
            >
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              {t("settings.save")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  title,
}: {
  icon: typeof ScanText;
  title: string;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <h2 className="text-base font-semibold">{title}</h2>
    </div>
  );
}

function OcrSettingsPanel({
  vendors,
  onChange,
  ocrMode,
  onOcrModeChange,
  loading,
}: {
  vendors: VendorForm[];
  onChange: (updater: SetStateAction<VendorForm[]>) => void;
  ocrMode: OcrMode;
  onOcrModeChange: (v: OcrMode) => void;
  loading: boolean;
}) {
  const { t } = useI18n();

  const updateVendor = useCallback(
    (id: string, patch: Partial<VendorForm>) => {
      onChange((prev) =>
        prev.map((v) => (v.id === id ? { ...v, ...patch } : v)),
      );
    },
    [onChange],
  );

  const updateModel = useCallback(
    (vendorId: string, modelId: string, name: string) => {
      onChange((prev) =>
        prev.map((v) =>
          v.id === vendorId
            ? {
                ...v,
                models: v.models.map((m) =>
                  m.id === modelId ? { ...m, name } : m,
                ),
              }
            : v,
        ),
      );
    },
    [onChange],
  );

  const setDefaultModel = useCallback(
    (vendorId: string, modelId: string) => {
      onChange((prev) =>
        prev.map((v) =>
          v.id === vendorId
            ? {
                ...v,
                models: v.models.map((m) => ({
                  ...m,
                  default: m.id === modelId,
                })),
              }
            : v,
        ),
      );
    },
    [onChange],
  );

  function addVendor() {
    const id = crypto.randomUUID();
    onChange((prev) => [
      ...prev,
      {
        id,
        name: t("settings.defaultVendorName", { n: prev.length + 1 }),
        baseUrl: "",
        apiKey: "",
        apiKeySet: false,
        clearApiKey: false,
        showKey: false,
        models: [{ id: crypto.randomUUID(), name: "", default: false }],
      },
    ]);
  }

  function removeVendor(id: string) {
    onChange((prev) => prev.filter((v) => v.id !== id));
  }

  function addModel(vendorId: string) {
    onChange((prev) =>
      prev.map((v) =>
        v.id === vendorId
          ? {
              ...v,
              models: [
                ...v.models,
                { id: crypto.randomUUID(), name: "", default: false },
              ],
            }
          : v,
      ),
    );
  }

  function removeModel(vendorId: string, modelId: string) {
    onChange((prev) =>
      prev.map((v) =>
        v.id === vendorId
          ? { ...v, models: v.models.filter((m) => m.id !== modelId) }
          : v,
      ),
    );
  }

  async function toggleShowKey(v: VendorForm) {
    if (v.showKey) {
      updateVendor(v.id, { showKey: false });
      return;
    }
    let val = v.apiKey;
    if (!val && v.apiKeySet) {
      try {
        val = (await revealOcrKey(v.id)) ?? "";
      } catch (e) {
        toast.error(t("toast.readKeyFailed"), { description: String(e) });
        return;
      }
    }
    updateVendor(v.id, { showKey: true, apiKey: val });
  }

  return (
    <>
      <Card className="gap-3 p-4">
        <div className="space-y-2">
          <Label>{t("settings.ocrEnabled")}</Label>
          <Tabs
            value={ocrMode}
            onValueChange={(v) => onOcrModeChange(v as OcrMode)}
          >
            <TabsList className="w-full">
              <TabsTrigger
                value="forceLocal"
                disabled={loading}
                className="flex-1 text-xs"
              >
                {t("settings.ocrMode.forceLocal")}
              </TabsTrigger>
              <TabsTrigger
                value="forceAi"
                disabled={loading}
                className="flex-1 text-xs"
              >
                {t("settings.ocrMode.forceAi")}
              </TabsTrigger>
              <TabsTrigger
                value="nonTextLocal"
                disabled={loading}
                className="flex-1 text-xs"
              >
                {t("settings.ocrMode.nonTextLocal")}
              </TabsTrigger>
              <TabsTrigger
                value="nonTextAi"
                disabled={loading}
                className="flex-1 text-xs"
              >
                {t("settings.ocrMode.nonTextAi")}
              </TabsTrigger>
              <TabsTrigger
                value="disabled"
                disabled={loading}
                className="flex-1 text-xs"
              >
                {t("settings.ocrMode.disabled")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">
            {t(`settings.ocrMode.${ocrMode}Desc`)}
          </p>
        </div>
      </Card>

      <div className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border bg-card py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("settings.loadingConfig")}
          </div>
        ) : vendors.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <KeyRound className="size-6" />
            </span>
            <div className="space-y-1">
              <p className="text-sm font-medium">{t("settings.noVendors")}</p>
              <p className="text-xs text-muted-foreground">
                {t("settings.noVendorsDesc")}
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={addVendor}>
              <Plus />
              {t("settings.addVendor")}
            </Button>
          </div>
        ) : (
          vendors.map((v) => (
            <VendorCard
              key={v.id}
              vendor={v}
              onPatch={(patch) => updateVendor(v.id, patch)}
              onRemove={() => removeVendor(v.id)}
              onAddModel={() => addModel(v.id)}
              onUpdateModel={(m, name) => updateModel(v.id, m, name)}
              onSetDefaultModel={(m) => setDefaultModel(v.id, m)}
              onRemoveModel={(m) => removeModel(v.id, m)}
              onToggleKey={() => toggleShowKey(v)}
            />
          ))
        )}
      </div>

      {vendors.length > 0 ? (
        <div className="flex items-center">
          <Button variant="secondary" size="sm" onClick={addVendor}>
            <Plus />
            {t("settings.addVendor")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

const THREAD_MIN = 1;
const THREAD_MAX = 16;

function clampThread(n: number): number {
  return Math.min(THREAD_MAX, Math.max(THREAD_MIN, Math.round(n)));
}

function ThreadSettingsPanel({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  return (
    <>
      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label>{t("settings.maxConcurrent")}</Label>
            <Input
              type="number"
              inputMode="numeric"
              min={THREAD_MIN}
              max={THREAD_MAX}
              step={1}
              value={Number.isFinite(value) ? value : ""}
              onChange={(e) => onChange(e.target.valueAsNumber)}
              disabled={disabled}
              placeholder={t("settings.threadPlaceholder")}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.threadsHint2")}
        </p>
      </Card>
    </>
  );
}

/**
 * Global hotkey that triggers screenshot recognition. Recorded by pressing a
 * key combination; stored in the accelerator syntax understood by the backend
 * (`Ctrl+Shift+KeyA`, `F8`, …); empty disables the hotkey.
 */
function SnipSettingsPanel({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label>{t("settings.screenshotHotkey")}</Label>
          <HotkeyInput value={value} onChange={onChange} disabled={disabled} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("settings.screenshotHotkeyHint")}
      </p>
    </Card>
  );
}

function TraySettingsPanel({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  return (
    <Card className="gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>{t("settings.tray")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("settings.trayDesc")}
          </p>
        </div>
        <Switch
          checked={value}
          onCheckedChange={onChange}
          disabled={disabled}
        />
      </div>
    </Card>
  );
}

const HOTKEY_MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

/** Friendly label for one token of an accelerator (`Ctrl`, `KeyA`, `F8`, …). */
function hotkeyTokenLabel(part: string): string {
  const lower = part.toLowerCase();
  if (lower === "ctrl" || lower === "control") return "Ctrl";
  if (lower === "alt" || lower === "option") return "Alt";
  if (lower === "shift") return "Shift";
  if (lower === "super" || lower === "meta" || lower === "win") return "Win";
  if (/^key[a-z]$/.test(part)) return part.slice(3).toUpperCase();
  if (/^digit\d$/.test(part)) return part.slice(5);
  const labels: Record<string, string> = {
    Space: "Space",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Enter: "Enter",
    Tab: "Tab",
    CapsLock: "CapsLock",
    Backspace: "Backspace",
    Delete: "Del",
    Insert: "Ins",
    Home: "Home",
    End: "End",
    PageUp: "PgUp",
    PageDown: "PgDn",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Escape: "Esc",
    PrintScreen: "PrtSc",
    ScrollLock: "ScrollLock",
    Pause: "Pause",
    ContextMenu: "Menu",
    NumpadAdd: "Num+",
    NumpadSubtract: "Num-",
    NumpadMultiply: "Num*",
    NumpadDivide: "Num/",
    NumpadDecimal: "Num.",
    NumpadEnter: "NumEnter",
  };
  return labels[part] ?? part;
}

/** Split a stored accelerator into chips for display. */
function hotkeyChips(value: string): string[] {
  return value
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(hotkeyTokenLabel);
}

/**
 * Press-to-record hotkey field. Click to start listening, then hold any
 * modifiers and press the final key. Esc cancels, lone Backspace clears.
 */
function HotkeyInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!recording) return;

    /** Chips shown while recording for the keys currently held down. */
    function previewChips(e: KeyboardEvent): string[] {
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Win");
      if (!HOTKEY_MODIFIER_CODES.has(e.code)) {
        parts.push(hotkeyTokenLabel(e.code));
      }
      return parts;
    }

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      setHeld(previewChips(e));

      // Esc aborts without changing the stored shortcut.
      if (e.code === "Escape") {
        setRecording(false);
        setHeld([]);
        return;
      }
      // Lone Backspace/Delete clears the current shortcut.
      if (
        (e.code === "Backspace" || e.code === "Delete") &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        onChange("");
        setRecording(false);
        setHeld([]);
        return;
      }
      // Any other non-modifier key completes the recording.
      if (!HOTKEY_MODIFIER_CODES.has(e.code)) {
        const mods: string[] = [];
        if (e.ctrlKey) mods.push("Ctrl");
        if (e.altKey) mods.push("Alt");
        if (e.shiftKey) mods.push("Shift");
        if (e.metaKey) mods.push("Super");
        onChange([...mods, e.code].join("+"));
        setRecording(false);
        setHeld([]);
      }
    }

    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        // Clicking elsewhere cancels the recording.
        setRecording(false);
        setHeld([]);
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [recording, onChange]);

  const chips = recording ? held : hotkeyChips(value);

  return (
    <div ref={rootRef} className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => !disabled && setRecording(true)}
        disabled={disabled}
        aria-label={t("settings.screenshotHotkey")}
        className={cn(
          "flex h-9 min-w-52 flex-1 items-center gap-1.5 rounded-lg border px-3 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          recording
            ? "border-primary bg-primary/5 ring-2 ring-primary/20"
            : "border-input hover:bg-muted/40",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        {chips.length > 0 ? (
          chips.map((chip, i) => (
            <kbd
              key={`${chip}-${i}`}
              className="rounded-md border bg-muted/60 px-1.5 py-0.5 font-mono text-xs font-medium"
            >
              {chip}
            </kbd>
          ))
        ) : (
          <span className="text-muted-foreground">
            {recording
              ? t("settings.hotkeyRecording")
              : t("settings.hotkeyPlaceholder")}
          </span>
        )}
        <span className="flex-1" />
        {recording ? (
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" />
        ) : null}
      </button>
      {!recording && value ? (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          onClick={() => onChange("")}
          aria-label={t("tooltip.remove")}
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}

function CacheSettingsPanel({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  return (
    <>
      <Card className="gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <Label>{t("settings.cacheExtracted")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.cacheExtractedDesc")}
            </p>
          </div>
          <Switch
            checked={value}
            onCheckedChange={onChange}
            disabled={disabled}
          />
        </div>
      </Card>
    </>
  );
}

function ExcelSettingsPanel({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  return (
    <>
      <Card className="gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <Label>{t("settings.excelTablesOnly")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.excelTablesOnlyDesc")}
            </p>
          </div>
          <Switch
            checked={value}
            onCheckedChange={onChange}
            disabled={disabled}
          />
        </div>
      </Card>
    </>
  );
}

function VendorCard({
  vendor,
  onPatch,
  onRemove,
  onAddModel,
  onUpdateModel,
  onSetDefaultModel,
  onRemoveModel,
  onToggleKey,
}: {
  vendor: VendorForm;
  onPatch: (patch: Partial<VendorForm>) => void;
  onRemove: () => void;
  onAddModel: () => void;
  onUpdateModel: (modelId: string, name: string) => void;
  onSetDefaultModel: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
  onToggleKey: () => void;
}) {
  const { t } = useI18n();
  const v = vendor;
  return (
    <Card className="gap-3 p-4">
      <div className="flex items-center gap-2">
        <Input
          value={v.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder={t("settings.vendorName")}
          className="h-9 flex-1 text-base font-medium"
        />
        <Button variant="ghost" size="icon" onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label>{t("settings.baseUrl")}</Label>
        <Input
          value={v.baseUrl}
          onChange={(e) => onPatch({ baseUrl: e.target.value })}
          placeholder={t("settings.baseUrlPlaceholder")}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Label>{t("settings.apiKey")}</Label>
          {v.apiKeySet && !v.clearApiKey ? (
            <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="size-3" />
              {t("settings.keySaved")}
            </span>
          ) : null}
          {v.clearApiKey ? (
            <span className="rounded-md bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
              {t("settings.keyWillBeCleared")}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Input
            type={v.showKey ? "text" : "password"}
            value={v.apiKey}
            onChange={(e) => onPatch({ apiKey: e.target.value })}
            placeholder={
              v.apiKeySet ? t("settings.keyPlaceholderSet") : "sk-..."
            }
            disabled={v.clearApiKey}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleKey}
            disabled={!v.apiKeySet && !v.apiKey}
          >
            {v.showKey ? <EyeOff /> : <Eye />}
          </Button>
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label>{t("settings.models")}</Label>
        <div className="space-y-2">
          {v.models.map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => onSetDefaultModel(m.id)}
                    className={
                      m.default
                        ? "text-amber-500 hover:text-amber-500"
                        : "text-muted-foreground"
                    }
                  >
                    <Star className={m.default ? "fill-current" : ""} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("settings.defaultModel")}</TooltipContent>
              </Tooltip>
              <Input
                value={m.name}
                onChange={(e) => onUpdateModel(m.id, e.target.value)}
                placeholder={t("settings.modelPlaceholder")}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onRemoveModel(m.id)}
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
        <Button variant="secondary" size="sm" onClick={onAddModel}>
          <Plus />
          {t("settings.addModel")}
        </Button>
      </div>
    </Card>
  );
}
