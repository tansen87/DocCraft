import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cpu,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  Save,
  ScanText,
  ShieldCheck,
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
import {
  getAppSettings,
  getOcrConfig,
  revealOcrKey,
  saveOcrConfig,
  setAppSettings,
} from "@/lib/ipc";
import { setMaxConcurrent } from "@/lib/concurrency";
import { useI18n } from "@/i18n";
import type { OcrModel, OcrVendor, OcrVendorInput } from "@/lib/types";
import { cn } from "@/lib/utils";

type SettingsSection = "ocr" | "threads" | "cache";

const SECTIONS: {
  id: SettingsSection;
  labelKey: "settings.ocr" | "settings.threads" | "settings.cache";
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
    id: "cache",
    labelKey: "settings.cache",
    icon: Database,
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
      // may never cross the line — fall back to the last section.
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

      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-4 pr-3">
          <div className="space-y-8">
            <section id="settings-ocr" className="scroll-mt-3">
              <SectionHeader icon={ScanText} title={t("settings.ocr")} />
              <OcrSettingsPanel />
            </section>
            <section id="settings-threads" className="scroll-mt-3">
              <SectionHeader icon={Cpu} title={t("settings.threads")} />
              <ThreadSettingsPanel />
            </section>
            <section id="settings-cache" className="scroll-mt-3">
              <SectionHeader icon={Database} title={t("settings.cache")} />
              <CacheSettingsPanel />
            </section>
          </div>
        </div>
      </ScrollArea>
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

function OcrSettingsPanel() {
  const { t } = useI18n();
  const [vendors, setVendors] = useState<VendorForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getOcrConfig()
      .then((data) => {
        if (!cancelled) setVendors(data.map(toForm));
      })
      .catch((e) =>
        toast.error(t("toast.loadConfigFailed"), { description: String(e) }),
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const updateVendor = useCallback((id: string, patch: Partial<VendorForm>) => {
    setVendors((prev) =>
      prev.map((v) => (v.id === id ? { ...v, ...patch } : v)),
    );
  }, []);

  const updateModel = useCallback(
    (vendorId: string, modelId: string, name: string) => {
      setVendors((prev) =>
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
    [],
  );

  function addVendor() {
    const id = crypto.randomUUID();
    setVendors((prev) => [
      ...prev,
      {
        id,
        name: t("settings.defaultVendorName", { n: prev.length + 1 }),
        baseUrl: "",
        apiKey: "",
        apiKeySet: false,
        clearApiKey: false,
        showKey: false,
        models: [{ id: crypto.randomUUID(), name: "" }],
      },
    ]);
  }

  function removeVendor(id: string) {
    setVendors((prev) => prev.filter((v) => v.id !== id));
  }

  function addModel(vendorId: string) {
    updateVendor(vendorId, {
      models: [
        ...(vendors.find((v) => v.id === vendorId)?.models ?? []),
        { id: crypto.randomUUID(), name: "" },
      ],
    });
  }

  function removeModel(vendorId: string, modelId: string) {
    setVendors((prev) =>
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
    try {
      await saveOcrConfig(entries.map((e) => e.input));
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
      toast.success(t("toast.configSaved"));
    } catch (e) {
      toast.error(t("toast.saveFailed"), { description: String(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">{t("settings.ocrDesc")}</p>
      </div>

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
            <Button variant="outline" size="sm" onClick={addVendor}>
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
              onRemoveModel={(m) => removeModel(v.id, m)}
              onToggleKey={() => toggleShowKey(v)}
            />
          ))
        )}
      </div>

      {vendors.length > 0 ? (
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={addVendor}>
            <Plus />
            {t("settings.addVendor")}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            {t("settings.saveConfig")}
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

function ThreadSettingsPanel() {
  const { t } = useI18n();
  const [value, setValue] = useState<number>(1);
  const [cacheExtracted, setCacheExtracted] = useState<boolean>(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAppSettings()
      .then((s) => {
        if (cancelled) return;
        setValue(clampThread(s.maxConcurrent));
        setCacheExtracted(s.cacheExtractedText);
        setLoaded(true);
      })
      .catch((e) =>
        toast.error(t("toast.loadSettingsFailed"), { description: String(e) }),
      );
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function handleSave() {
    const n = clampThread(Number.isFinite(value) ? value : 1);
    setSaving(true);
    setValue(n);
    try {
      await setAppSettings({
        maxConcurrent: n,
        cacheExtractedText: cacheExtracted,
      });
      setMaxConcurrent(n);
      toast.success(t("toast.concurrencySaved"), {
        description: t("toast.concurrencyLimit", { n }),
      });
    } catch (e) {
      toast.error(t("toast.saveFailed"), { description: String(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">
          {t("settings.threadsDesc")}
        </p>
      </div>

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
              onChange={(e) => setValue(e.target.valueAsNumber)}
              disabled={!loaded}
              placeholder={t("settings.threadPlaceholder")}
            />
          </div>
          <Button onClick={handleSave} disabled={saving || !loaded}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            {t("settings.save")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.threadsHint2")}
        </p>
      </Card>
    </>
  );
}

function CacheSettingsPanel() {
  const { t } = useI18n();
  const [maxConcurrent, setMaxConcurrentValue] = useState<number>(1);
  const [cacheExtracted, setCacheExtracted] = useState<boolean>(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAppSettings()
      .then((s) => {
        if (cancelled) return;
        setMaxConcurrentValue(clampThread(s.maxConcurrent));
        setCacheExtracted(s.cacheExtractedText);
        setLoaded(true);
      })
      .catch((e) =>
        toast.error(t("toast.loadSettingsFailed"), { description: String(e) }),
      );
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function handleSave() {
    setSaving(true);
    try {
      await setAppSettings({
        maxConcurrent,
        cacheExtractedText: cacheExtracted,
      });
      toast.success(t("toast.configSaved"));
    } catch (e) {
      toast.error(t("toast.saveFailed"), { description: String(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">
          {t("settings.cacheDesc")}
        </p>
      </div>

      <Card className="gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <Label>{t("settings.cacheExtracted")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.cacheExtractedDesc")}
            </p>
          </div>
          <Switch
            checked={cacheExtracted}
            onCheckedChange={setCacheExtracted}
            disabled={!loaded}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.cacheExtractedHint")}
        </p>
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving || !loaded}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            {t("settings.save")}
          </Button>
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
  onRemoveModel,
  onToggleKey,
}: {
  vendor: VendorForm;
  onPatch: (patch: Partial<VendorForm>) => void;
  onRemove: () => void;
  onAddModel: () => void;
  onUpdateModel: (modelId: string, name: string) => void;
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
          {v.apiKeySet ? (
            v.clearApiKey ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onPatch({ clearApiKey: false })}
              >
                {t("settings.cancelClear")}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onPatch({ clearApiKey: true, apiKey: "" })}
              >
                {t("settings.clear")}
              </Button>
            )
          ) : null}
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label>{t("settings.models")}</Label>
        <div className="space-y-2">
          {v.models.map((m) => (
            <div key={m.id} className="flex items-center gap-2">
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
        <Button variant="outline" size="sm" onClick={onAddModel}>
          <Plus />
          {t("settings.addModel")}
        </Button>
      </div>
    </Card>
  );
}
