import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, SetStateAction } from "react";
import {
  open as openFileDialog,
  save as saveFileDialog,
} from "@tauri-apps/plugin-dialog";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  Save,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import type {
  OcrMode,
  OcrModelSize,
  ParagraphMode,
  LayoutMode,
  LocalImportResult,
  ModelGroupDto,
  ModelProgress,
  ModelsSnapshot,
} from "@/lib/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  addLocalModels,
  clearSkippedVersion,
  downloadModels,
  exportConfig,
  getAppSettings,
  getOcrConfig,
  getUpdateState,
  getUsageStats,
  importConfig,
  listLayoutModels,
  listModels,
  onModelProgress,
  revealOcrKey,
  saveOcrConfig,
  setAppSettings,
  clearUsageStats,
} from "@/lib/ipc";
import { setMaxConcurrent as applyRuntimeConcurrency } from "@/lib/concurrency";
import { useI18n } from "@/i18n";
import { translations, type TranslationKey } from "@/i18n/translations";
import { formatDuration } from "@/lib/format-duration";
import { localDate } from "@/lib/usage";
import type {
  AppSettings,
  LayoutModelInfo,
  OcrModel,
  OcrVendor,
  OcrVendorInput,
  UpdateSnapshot,
  UsagePeriodStats,
  UsageStats,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type SettingsSection =
  | "ocr"
  | "models"
  | "snip"
  | "textSep"
  | "draw"
  | "excel"
  | "threads"
  | "appearance"
  | "backup"
  | "stats"
  | "update";

/**
 * Sidebar navigation: one flat list of the cards, in the order they are
 * rendered top to bottom, so a click always lands on the card the list implies.
 * Text only (no icons) - eleven entries stay scannable without adding visual
 * noise.
 */
const SECTIONS: { id: SettingsSection; labelKey: TranslationKey }[] = [
  // Model files first: the local engine can only run once they exist.
  { id: "models", labelKey: "settings.modelFiles" },
  { id: "ocr", labelKey: "settings.ocr" },
  // Screenshot recognition is just another OCR entry point.
  { id: "snip", labelKey: "snip.capture" },
  { id: "textSep", labelKey: "settings.textAndLineBreak" },
  { id: "draw", labelKey: "settings.drawTable" },
  { id: "excel", labelKey: "settings.excel" },
  { id: "threads", labelKey: "settings.threads" },
  { id: "backup", labelKey: "settings.backup" },
  { id: "stats", labelKey: "settings.stats" },
  { id: "appearance", labelKey: "settings.appearance" },
  { id: "update", labelKey: "settings.update" },
];

/** Height of a card's sticky head; a jumped-to row is parked below it. */
const STICKY_HEAD_OFFSET = 56;

/** How long a jumped-to row stays highlighted (ms). */
const FLASH_MS = 1600;

/**
 * One matched row of a settings card. The element is resolved while the index
 * is built, so jumping needs no stable id per row.
 */
interface SearchHit {
  el: HTMLElement;
  /** The row's own label (never the description). */
  label: string;
  /** The matched description, when the label itself is not the match. */
  detail?: string;
}

interface SearchGroup {
  id: SettingsSection;
  label: string;
  hits: SearchHit[];
}

/**
 * Every section is one card. The sticky head lives inside it, so the card must
 * stay free of `overflow-hidden` (that would break `position: sticky`).
 */
const SECTION_CARD =
  "scroll-mt-4 rounded-2xl border border-border/70 bg-card/80 pb-1 shadow-sm backdrop-blur-sm";

/**
 * One entry per setting that can be edited, so the save bar can say *how many*
 * things are pending and which ones. The key is what `markDirty()` records;
 * the value is the label shown for it.
 */
const DIRTY_LABELS = {
  vendors: "settings.subVendors",
  ocrMode: "settings.ocrEnabled",
  ocrModelSize: "settings.ocrModelSize",
  ocrTextCleanup: "settings.ocrTextCleanup",
  layout: "settings.ocrLayoutMode",
  layoutModel: "settings.ocrLayoutModel",
  layoutThreshold: "settings.layoutScoreThreshold",
  layoutHeaderFooter: "settings.layoutDropHeaderFooter",
  aiPrompt: "settings.aiOcrPrompt",
  drawPrompt: "settings.drawTablePrompt",
  hotkey: "settings.screenshotHotkey",
  snipPopup: "settings.snipResultPopup",
  snipAutoCopy: "settings.snipAutoCopy",
  paragraphMode: "settings.paragraphMode",
  textSeparator: "settings.textSeparator",
  cacheExtracted: "settings.cacheExtracted",
  excelTablesOnly: "settings.excelTablesOnly",
  stripMdSyntax: "settings.stripMdSyntax",
  writeNumeric: "settings.writeNumeric",
  maxConcurrent: "settings.maxConcurrent",
  localOcrThreads: "settings.localOcrThreads",
  glassBlur: "settings.glassBlur",
  mainOpacity: "settings.mainWindowOpacity",
  snipOpacity: "settings.snipResultOpacity",
  tray: "settings.tray",
  autoCheckUpdate: "update.autoCheck",
} satisfies Record<string, TranslationKey>;

type DirtyField = keyof typeof DIRTY_LABELS;

/** How many changed-field labels the save tooltip lists before eliding. */
const DIRTY_PREVIEW_LIMIT = 6;

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
  const [section, setSection] = useState<SettingsSection>(SECTIONS[0].id);
  /** Sidebar filter; Ctrl K focuses it. */
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  /** The scrolling column of cards; see `scrollViewport()`. */
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [vendors, setVendors] = useState<VendorForm[]>([]);
  const [ocrMode, setOcrMode] = useState<OcrMode>("disabled");
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [localOcrThreads, setLocalOcrThreads] = useState(0);
  const [cacheExtracted, setCacheExtracted] = useState(true);
  const [excelTablesOnly, setExcelTablesOnly] = useState(true);
  const [screenshotHotkey, setScreenshotHotkey] = useState("");
  const [ocrModelSize, setOcrModelSize] = useState<OcrModelSize>("small");
  const [ocrLayoutMode, setOcrLayoutMode] = useState<LayoutMode>("off");
  const [ocrLayoutModel, setOcrLayoutModel] = useState("PP-DocLayoutV3");
  const [layoutModels, setLayoutModels] = useState<LayoutModelInfo[]>([]);
  const [layoutScoreThreshold, setLayoutScoreThreshold] = useState(0.5);
  const [layoutDropHeaderFooter, setLayoutDropHeaderFooter] = useState(true);
  const [ocrTextCleanup, setOcrTextCleanup] = useState(true);
  const [stripMdSyntax, setStripMdSyntax] = useState(false);
  const [writeNumeric, setWriteNumeric] = useState(false);
  const [textSeparator, setTextSeparator] = useState(" ");
  const [paragraphMode, setParagraphMode] = useState<ParagraphMode>("guided");
  const [aiOcrPrompt, setAiOcrPrompt] = useState("");
  const [drawTablePrompt, setDrawTablePrompt] = useState("");
  const [enableTray, setEnableTray] = useState(true);
  const [snipResultPopup, setSnipResultPopup] = useState(true);
  const [snipAutoCopy, setSnipAutoCopy] = useState(true);
  const [snipResultOpacity, setSnipResultOpacity] = useState(60);
  const [mainWindowOpacity, setMainWindowOpacity] = useState(100);
  const [glassBlurEnabled, setGlassBlurEnabled] = useState(false);
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true);
  /**
   * Backend-owned update fields. They are echoed back on save (the payload
   * replaces the whole settings struct) but only the backend changes them.
   */
  const [updateExtras, setUpdateExtras] = useState({
    skippedVersion: "",
    lastRunVersion: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [dirtyFields, setDirtyFields] = useState<Set<DirtyField>>(new Set());
  const dirty = dirtyFields.size > 0;
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  /** Bumped after a config import so the load effect re-runs. */
  const [reloadKey, setReloadKey] = useState(0);
  /** Cards + matched rows for the current filter (empty when not searching). */
  const [searchGroups, setSearchGroups] = useState<SearchGroup[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getOcrConfig(),
      getAppSettings(),
      getUsageStats(localDate()),
      listLayoutModels().catch(() => []),
    ])
      .then(([ocrVendors, settings, usage, layoutModels]) => {
        if (cancelled) return;
        setLayoutModels(layoutModels);
        setVendors(ocrVendors.map(toForm));
        setOcrMode(settings.ocrMode);
        setMaxConcurrent(clampThread(settings.maxConcurrent));
        setLocalOcrThreads(settings.localOcrThreads ?? 0);
        setCacheExtracted(settings.cacheExtractedText);
        setExcelTablesOnly(settings.excelTablesOnly);
        setScreenshotHotkey(settings.screenshotHotkey ?? "");
        setOcrModelSize(settings.ocrModelSize ?? "small");
        setOcrLayoutMode(settings.ocrLayoutMode ?? "off");
        setOcrLayoutModel(settings.ocrLayoutModel ?? "PP-DocLayoutV3");
        setLayoutScoreThreshold(settings.layoutScoreThreshold ?? 0.5);
        setLayoutDropHeaderFooter(settings.layoutDropHeaderFooter ?? true);
        setOcrTextCleanup(settings.ocrTextCleanup ?? true);
        setStripMdSyntax(settings.stripMdSyntax ?? false);
        setWriteNumeric(settings.writeNumeric ?? false);
        setTextSeparator(settings.textSeparator);
        setParagraphMode(
          settings.paragraphMode === "smart" ||
            settings.paragraphMode === "none" ||
            settings.paragraphMode === "guided"
            ? settings.paragraphMode
            : "guided",
        );
        setAiOcrPrompt(settings.aiOcrPrompt ?? "");
        setDrawTablePrompt(settings.drawTablePrompt ?? "");
        setEnableTray(settings.enableTray);
        setSnipResultPopup(settings.snipResultPopup ?? true);
        setSnipAutoCopy(settings.snipAutoCopy ?? true);
        setSnipResultOpacity(settings.snipResultOpacity ?? 60);
        setMainWindowOpacity(settings.mainWindowOpacity ?? 100);
        setGlassBlurEnabled(settings.glassBlurEnabled ?? false);
        setAutoCheckUpdate(settings.autoCheckUpdate ?? true);
        setUpdateExtras({
          skippedVersion: settings.updateSkippedVersion ?? "",
          lastRunVersion: settings.lastRunVersion ?? "",
        });
        setUsageStats(usage);
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
  }, [t, reloadKey]);

  const markDirty = (field: DirtyField) => {
    if (!loaded) return;
    setDirtyFields((prev) =>
      prev.has(field) ? prev : new Set(prev).add(field),
    );
  };

  /** Re-fetch usage stats after "clear statistics" so the card resets. */
  const refreshUsage = useCallback(async () => {
    const stats = await getUsageStats(localDate()).catch(() => null);
    setUsageStats(stats);
  }, []);

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
      localOcrThreads: clampOcrThreads(
        Number.isFinite(localOcrThreads) ? localOcrThreads : 0,
      ),
      cacheExtractedText: cacheExtracted,
      excelTablesOnly,
      ocrMode,
      screenshotHotkey: screenshotHotkey.trim() || null,
      enableTray,
      ocrModelSize,
      ocrLayoutMode,
      ocrLayoutModel,
      layoutScoreThreshold: Number.isFinite(layoutScoreThreshold)
        ? Math.min(1, Math.max(0, layoutScoreThreshold))
        : 0.5,
      layoutDropHeaderFooter,
      ocrTextCleanup,
      stripMdSyntax,
      writeNumeric,
      textSeparator,
      paragraphMode,
      aiOcrPrompt,
      drawTablePrompt,
      snipResultPopup,
      snipAutoCopy,
      snipResultOpacity,
      mainWindowOpacity,
      glassBlurEnabled,
      autoCheckUpdate,
      updateSkippedVersion: updateExtras.skippedVersion,
      lastRunVersion: updateExtras.lastRunVersion,
    };
    try {
      await Promise.all([
        setAppSettings(settings),
        saveOcrConfig(entries.map((e) => e.input)),
      ]);
      setMaxConcurrent(settings.maxConcurrent);
      setLocalOcrThreads(settings.localOcrThreads ?? 0);
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
      setDirtyFields(new Set());
      // Let other views re-sync anything derived from app settings
      // (e.g. MD→Excel's tables-only toggle).
      window.dispatchEvent(new Event("doccraft:settings-saved"));
      // Notify the snip-result window so its opacity updates immediately.
      emitTo("snip-result", "snip:settings-changed", {}).catch(() => {});
      toast.success(t("toast.configSaved"));
    } catch (e) {
      toast.error(t("toast.saveFailed"), { description: String(e) });
    } finally {
      setSaving(false);
    }
  }

  /**
   * The scroll container that holds the section cards (Radix viewport). Scoped
   * to the cards column: the sidebar is a `ScrollArea` too, so "the first
   * viewport in the page" is no longer the right one.
   */
  function scrollViewport(): HTMLElement | null {
    return (
      contentRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      ) ?? null
    );
  }

  // Ctrl K focuses the sidebar filter - the shortcut users expect from a
  // settings page. No command palette: eleven entries live in one visible list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * The active nav entry follows the card whose sticky head owns the top band
   * of the scroll viewport. An IntersectionObserver replaces the previous
   * "25 % reference line + pinned flag" scroll maths; the only extra rule is
   * the last section, which never reaches that band when it is shorter than
   * the viewport (hence the bottom check instead of a trailing spacer).
   */
  useEffect(() => {
    const vp = scrollViewport();
    if (!vp) return;
    const lastId = SECTIONS[SECTIONS.length - 1].id;
    const atBottom = () =>
      vp.scrollHeight - vp.clientHeight > 8 &&
      vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 2;

    const observer = new IntersectionObserver(
      (entries) => {
        if (atBottom()) {
          setSection(lastId);
          return;
        }
        const visible = new Set(
          entries.filter((e) => e.isIntersecting).map((e) => e.target.id),
        );
        const first = SECTIONS.find((s) => visible.has(`settings-${s.id}`));
        if (first) setSection(first.id);
      },
      // Only the top 30 % of the viewport counts: a tall card stays "active"
      // until the next card head scrolls into that band.
      { root: vp, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    SECTIONS.map((s) => document.getElementById(`settings-${s.id}`))
      .filter((el): el is HTMLElement => el !== null)
      .forEach((el) => observer.observe(el));

    const onScroll = () => {
      if (atBottom()) setSection(lastId);
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      vp.removeEventListener("scroll", onScroll);
    };
  }, []);

  /** Jump to a section; the observer picks the highlight up on arrival. */
  function jumpTo(id: SettingsSection) {
    setSection(id);
    const vp = scrollViewport();
    const el = document.getElementById(`settings-${id}`);
    if (!vp || !el) return;
    const top =
      el.getBoundingClientRect().top -
      vp.getBoundingClientRect().top +
      vp.scrollTop;
    vp.scrollTo({ top: Math.max(top - 4, 0), behavior: "smooth" });
  }

  /** Briefly tint a row so the eye can find it after a search jump. */
  function flash(el: HTMLElement) {
    el.classList.remove("doccraft-flash");
    // Reflow: a repeat click must restart the animation, not ignore it.
    void el.offsetWidth;
    el.classList.add("doccraft-flash");
    window.setTimeout(() => el.classList.remove("doccraft-flash"), FLASH_MS);
  }

  /** Jump to a search hit: the section head, or one row inside it. */
  function openHit(groupId: SettingsSection, hit?: SearchHit) {
    setSection(groupId);
    const vp = scrollViewport();
    const el = hit?.el ?? document.getElementById(`settings-${groupId}`);
    if (!vp || !el) return;
    const top =
      el.getBoundingClientRect().top -
      vp.getBoundingClientRect().top +
      vp.scrollTop;
    // Rows sit under the card's sticky head, so they need the extra offset.
    const offset = hit ? STICKY_HEAD_OFFSET : 4;
    vp.scrollTo({ top: Math.max(top - offset, 0), behavior: "smooth" });
    if (hit) flash(hit.el);
  }

  /** Throw away unsaved edits by re-running the load pipeline. */
  function discardChanges() {
    setDirtyFields(new Set());
    setReloadKey((k) => k + 1);
  }

  const needle = query.trim().toLowerCase();

  /**
   * The filter matches the settings' own text - row labels, descriptions and
   * the current option values inside the controls - not just the eleven card
   * titles, so "provider", "guided" or a hotkey name all find their row. The
   * index is read off the rendered cards: every string already runs through
   * `t()`, so both languages are covered without a second dictionary, and the
   * cards hold the live values (a select's *current* label, not its options).
   * Rebuilt whenever the filter, the language or the loaded state changes.
   */
  useEffect(() => {
    const needleNow = query.trim().toLowerCase();
    if (!needleNow) {
      setSearchGroups([]);
      return;
    }
    const groups: SearchGroup[] = [];
    for (const s of SECTIONS) {
      const card = document.getElementById(`settings-${s.id}`);
      if (!card) continue;
      const head = card.querySelector<HTMLElement>("[data-setting-head]");
      const title = head?.querySelector("h2")?.textContent?.trim() || t(s.labelKey);
      const headHit = (head?.textContent ?? "")
        .toLowerCase()
        .includes(needleNow);
      const hits: SearchHit[] = [];
      card.querySelectorAll<HTMLElement>("[data-setting-row]").forEach((el) => {
        if (!(el.textContent ?? "").toLowerCase().includes(needleNow)) return;
        const label = el.dataset.settingLabel?.trim() || el.textContent?.trim() || "";
        const description = el.dataset.settingDesc?.trim() ?? "";
        hits.push({
          el,
          label,
          // Only spell out the description when it is what matched, so the
          // result list answers "why is this here?" in one line.
          detail:
            description && !label.toLowerCase().includes(needleNow)
              ? description
              : undefined,
        });
      });
      if (headHit || hits.length > 0) {
        groups.push({ id: s.id, label: title, hits });
      }
    }
    setSearchGroups(groups);
  }, [query, t, loading]);

  /** What the save tooltip lists: the changed settings, in change order. */
  const changedLabels = Array.from(dirtyFields).map((field) =>
    t(DIRTY_LABELS[field]),
  );
  const changedPreview =
    changedLabels.slice(0, DIRTY_PREVIEW_LIMIT).join(" · ") +
    (changedLabels.length > DIRTY_PREVIEW_LIMIT ? " …" : "");

  return (
    <div
      ref={containerRef}
      className="relative flex w-full min-h-0 flex-1 gap-3"
    >
      {/* Text-only navigation: a flat list of the cards, or - while filtering -
          the matching rows of those cards. */}
      <aside className="hidden w-[188px] shrink-0 flex-col gap-3 md:flex">
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          className="h-8 w-full shrink-0 rounded-lg border border-border/70 bg-card/60 px-2.5 text-[13px] outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
        />
        {needle ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex w-full flex-col gap-3 pb-2 pr-1">
              {searchGroups.map((group) => (
                <div key={group.id} className="flex flex-col gap-0.5">
                  {/* Card title: jumps to the top of the card. */}
                  <button
                    type="button"
                    onClick={() => openHit(group.id)}
                    className="rounded-md px-2.5 py-0.5 text-left text-[11px] font-semibold tracking-[0.02em] text-muted-foreground/80 transition-colors hover:text-foreground"
                  >
                    {group.label}
                  </button>
                  {/* Matched rows, indented one level under their card. */}
                  {group.hits.map((hit, i) => (
                    <button
                      key={`${group.id}-${i}`}
                      type="button"
                      onClick={() => openHit(group.id, hit)}
                      className="group flex flex-col gap-0.5 rounded-lg py-1 pl-5 pr-2 text-left transition-colors hover:bg-muted/60"
                    >
                      <span className="truncate text-[13px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                        {hit.label}
                      </span>
                      {hit.detail ? (
                        <span className="truncate text-[11px] text-muted-foreground/70">
                          {hit.detail}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ))}
              {searchGroups.length === 0 ? (
                <p className="px-2.5 py-1 text-xs text-muted-foreground">
                  {t("settings.searchEmpty")}
                </p>
              ) : null}
            </div>
          </ScrollArea>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex w-full flex-col gap-0.5 pb-2 pr-1">
              {SECTIONS.map((s) => {
                const active = section === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => jumpTo(s.id)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex h-8 items-center rounded-lg px-2.5 text-left text-[13px] font-medium transition-colors duration-150",
                      active
                        ? "bg-primary/[0.08] text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    {t(s.labelKey)}
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </aside>

      <div
        ref={contentRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
      >
        {/* No page title here: the window's tab strip already says 设置, and a
            second copy only ate vertical space. From md up the sidebar owns
            navigation, so the head slot is empty; below md it holds the
            section picker (the sidebar is gone there). */}
        <div className="md:hidden">
          <Select
            value={section}
            onValueChange={(v) => jumpTo(v as SettingsSection)}
          >
            <SelectTrigger
              className="w-full"
              aria-label={t("settings.sectionPicker")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SECTIONS.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {t(s.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Same ScrollArea (and same scrollbar) as the rest of the app. Its
            content wrapper is a `display: table` box, so the sticky heads were
            worth measuring: at scrollTop 700 the head reported top = 0 relative
            to the viewport, i.e. it does stick. */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="pb-6 pr-3 pt-2">
            <div className="space-y-4">
              {/* Models first: without them the local engine cannot run, so the
                  prerequisite sits above the engine it belongs to. */}
              <section id="settings-models" className={SECTION_CARD}>
                <SectionHeader
                  title={t("settings.modelFiles")}
                  hint={t("settings.sectionHint.models")}
                />
                <ModelsPanel />
              </section>
              <section id="settings-ocr" className={SECTION_CARD}>
                <SectionHeader
                  title={t("settings.ocr")}
                  hint={t("settings.sectionHint.ocr")}
                />
                <OcrSettingsPanel
                  vendors={vendors}
                  onChange={(updater) => {
                    setVendors(updater);
                    markDirty("vendors");
                  }}
                  ocrMode={ocrMode}
                  onOcrModeChange={(v) => {
                    setOcrMode(v);
                    markDirty("ocrMode");
                  }}
                  loading={loading}
                  ocrModelSize={ocrModelSize}
                  onOcrModelSizeChange={(v) => {
                    setOcrModelSize(v);
                    markDirty("ocrModelSize");
                  }}
                  ocrLayoutMode={ocrLayoutMode}
                  onOcrLayoutModeChange={(v) => {
                    setOcrLayoutMode(v);
                    markDirty("layout");
                  }}
                  ocrLayoutModel={ocrLayoutModel}
                  onOcrLayoutModelChange={(v) => {
                    setOcrLayoutModel(v);
                    markDirty("layoutModel");
                  }}
                  layoutModels={layoutModels}
                  layoutScoreThreshold={layoutScoreThreshold}
                  onLayoutScoreThresholdChange={(v) => {
                    setLayoutScoreThreshold(v);
                    markDirty("layoutThreshold");
                  }}
                  layoutDropHeaderFooter={layoutDropHeaderFooter}
                  onLayoutDropHeaderFooterChange={(v) => {
                    setLayoutDropHeaderFooter(v);
                    markDirty("layoutHeaderFooter");
                  }}
                  ocrTextCleanup={ocrTextCleanup}
                  onOcrTextCleanupChange={(v) => {
                    setOcrTextCleanup(v);
                    markDirty("ocrTextCleanup");
                  }}
                  aiOcrPrompt={aiOcrPrompt}
                  onAiOcrPromptChange={(v) => {
                    setAiOcrPrompt(v);
                    markDirty("aiPrompt");
                  }}
                  drawTablePrompt={drawTablePrompt}
                  onDrawTablePromptChange={(v) => {
                    setDrawTablePrompt(v);
                    markDirty("drawPrompt");
                  }}
                />
              </section>
              <section id="settings-snip" className={SECTION_CARD}>
                <SectionHeader
                  title={t("snip.capture")}
                  hint={t("settings.sectionHint.snip")}
                />
                <SnipSettingsPanel
                  value={screenshotHotkey}
                  onChange={(v) => {
                    setScreenshotHotkey(v);
                    markDirty("hotkey");
                  }}
                  resultPopup={snipResultPopup}
                  onResultPopupChange={(v) => {
                    setSnipResultPopup(v);
                    markDirty("snipPopup");
                  }}
                  autoCopy={snipAutoCopy}
                  onAutoCopyChange={(v) => {
                    setSnipAutoCopy(v);
                    markDirty("snipAutoCopy");
                  }}
                  disabled={loading}
                />
              </section>
              <section id="settings-textSep" className={SECTION_CARD}>
                <SectionHeader
                  title={t("settings.textAndLineBreak")}
                  hint={t("settings.sectionHint.textSep")}
                />
                <ParagraphModeSettingsPanel
                  value={paragraphMode}
                  onChange={(v) => {
                    setParagraphMode(v);
                    markDirty("paragraphMode");
                  }}
                  disabled={loading}
                />
                <TextSepSettingsPanel
                  value={textSeparator}
                  onChange={(v) => {
                    setTextSeparator(v);
                    markDirty("textSeparator");
                  }}
                  disabled={loading}
                />
              </section>
              <section id="settings-draw" className={SECTION_CARD}>
                <SectionHeader
                  title={t("settings.drawTable")}
                  hint={t("settings.sectionHint.draw")}
                />
                <DrawSettingsPanel
                  value={cacheExtracted}
                  onChange={(v) => {
                    setCacheExtracted(v);
                    markDirty("cacheExtracted");
                  }}
                  disabled={loading}
                />
              </section>
              <section id="settings-excel" className={SECTION_CARD}>
                <SectionHeader
                  title={t("settings.excel")}
                  hint={t("settings.sectionHint.excel")}
                />
                <ExcelSettingsPanel
                  value={excelTablesOnly}
                  onChange={(v) => {
                    setExcelTablesOnly(v);
                    markDirty("excelTablesOnly");
                  }}
                  stripMdSyntax={stripMdSyntax}
                  onStripMdSyntaxChange={(v) => {
                    setStripMdSyntax(v);
                    markDirty("stripMdSyntax");
                  }}
                  writeNumeric={writeNumeric}
                  onWriteNumericChange={(v) => {
                    setWriteNumeric(v);
                    markDirty("writeNumeric");
                  }}
                  disabled={loading}
                />
              </section>
              <section id="settings-threads" className={SECTION_CARD}>
                <SectionHeader
                  title={t("settings.threads")}
                  hint={t("settings.sectionHint.threads")}
                />
                <ThreadSettingsPanel
                  value={maxConcurrent}
                  onChange={(n) => {
                    setMaxConcurrent(n);
                    markDirty("maxConcurrent");
                  }}
                  localOcrThreads={localOcrThreads}
                  onLocalOcrThreadsChange={(n) => {
                    setLocalOcrThreads(n);
                    markDirty("localOcrThreads");
                  }}
                  disabled={loading}
                />
              </section>
              <section id="settings-backup" className={SECTION_CARD}>
                <SectionHeader
                  title={t("settings.backup")}
                  hint={t("settings.sectionHint.backup")}
                />
                <BackupPanel
                  busy={loading}
                  onImported={() => {
                    setDirtyFields(new Set());
                    setReloadKey((k) => k + 1);
                  }}
                />
              </section>
              <section id="settings-stats" className={SECTION_CARD}>
                <SectionHeader
                  title={t("settings.stats")}
                  hint={t("settings.sectionHint.stats")}
                />
                <UsageStatsPanel
                  stats={usageStats}
                  busy={loading}
                  onCleared={() => void refreshUsage()}
                />
              </section>
              <section id="settings-appearance" className={SECTION_CARD}>
                <SectionHeader
                  title={t("settings.appearance")}
                  hint={t("settings.sectionHint.appearance")}
                />
                <GlassSettingsPanel
                  blurEnabled={glassBlurEnabled}
                  onBlurEnabledChange={(v) => {
                    setGlassBlurEnabled(v);
                    markDirty("glassBlur");
                    // Live preview: update both windows without saving.
                    window.dispatchEvent(
                      new CustomEvent("doccraft:opacity-preview", {
                        detail: { blur: v },
                      }),
                    );
                    emitTo("snip-result", "snip:settings-changed", {
                      blur: v,
                    }).catch(() => {});
                  }}
                  resultOpacity={snipResultOpacity}
                  onResultOpacityChange={(v) => {
                    setSnipResultOpacity(v);
                    markDirty("snipOpacity");
                    // Live preview: send value directly to snip result window.
                    emitTo("snip-result", "snip:settings-changed", {
                      opacity: v,
                    }).catch(() => {});
                  }}
                  mainOpacity={mainWindowOpacity}
                  onMainOpacityChange={(v) => {
                    setMainWindowOpacity(v);
                    markDirty("mainOpacity");
                    // Live preview: update main window background without saving.
                    window.dispatchEvent(
                      new CustomEvent("doccraft:opacity-preview", {
                        detail: { mainWindow: v },
                      }),
                    );
                  }}
                  disabled={loading}
                />
                <TraySettingsPanel
                  value={enableTray}
                  onChange={(v) => {
                    setEnableTray(v);
                    markDirty("tray");
                  }}
                  disabled={loading}
                />
              </section>
              <section id="settings-update" className={SECTION_CARD}>
                <SectionHeader
                  title={t("settings.update")}
                  hint={t("settings.sectionHint.update")}
                />
                <UpdateSettingsPanel
                  autoCheck={autoCheckUpdate}
                  onAutoCheckChange={(v) => {
                    setAutoCheckUpdate(v);
                    markDirty("autoCheckUpdate");
                  }}
                  skippedVersion={updateExtras.skippedVersion}
                  onSkippedCleared={() =>
                    setUpdateExtras((prev) => ({ ...prev, skippedVersion: "" }))
                  }
                  disabled={loading}
                />
              </section>
            </div>
          </div>
        </ScrollArea>

        {/* Save bar. `flex-none` and outside the scroll area, so it neither
            covers the last rows (the old floating pill) nor sits under the
            window controls in the top-right corner. */}
        <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border/70 bg-card/80 px-3 py-2">
          {dirty ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="flex cursor-default items-center gap-1.5 rounded-md text-xs font-medium text-warning outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
                >
                  <span className="size-1.5 rounded-full bg-current" />
                  {t("settings.unsavedCount", { count: dirtyFields.size })}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" align="start" className="max-w-72">
                {changedPreview}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t("settings.allSaved")}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {dirty ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={discardChanges}
                disabled={saving}
              >
                {t("settings.discard")}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSave}
              disabled={saving || !loaded || !dirty}
            >
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              {t("settings.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Row group inside a card. It deliberately has no box of its own: the
 * `<section>` is the card now, and a group is just a run of hairline-separated
 * rows - replacing the old "one glass panel per row" stack.
 */
function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("divide-y divide-border/60", className)}>{children}</div>
  );
}

/** Second-level label inside a card (engine / layout / providers / prompts). */
function SubSection({
  label,
  hint,
  first,
}: {
  label: string;
  hint?: string;
  /** The first sub-section in a card has no top hairline. */
  first?: boolean;
}) {
  return (
    <div
      data-setting-row
      data-setting-label={label}
      data-setting-desc={hint}
      className={cn(
        "flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 pb-1 pt-3",
        !first && "border-t border-border/60",
      )}
    >
      <span className="text-[11px] font-semibold text-muted-foreground">
        {label}
      </span>
      {hint ? (
        <span className="text-[11px] text-muted-foreground/75">{hint}</span>
      ) : null}
    </div>
  );
}

/**
 * One settings row: label + description on the left, control on the right.
 * `data-setting-row` / `-label` / `-desc` mark it for the settings filter.
 */
function SettingRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-setting-row
      data-setting-label={label}
      data-setting-desc={description}
      className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-x-6"
    >
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={htmlFor}>{label}</Label>
        {description ? (
          <p className="text-xs leading-relaxed text-muted-foreground whitespace-pre-line">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ml-auto sm:justify-end sm:pl-2">
        {children}
      </div>
    </div>
  );
}

/** Sticky card head: section title + a one-line summary of what lives inside. */
function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    // Solid background, no backdrop-filter: a sticky band that samples the
    // rows scrolling underneath needs a compositing pass this WebView already
    // does for the window glass, and a solid head is the conventional look.
    // `data-setting-head` marks the block the settings filter reads the card
    // title and summary off.
    <div
      data-setting-head
      className="sticky top-0 z-10 rounded-t-2xl border-b border-border/60 bg-card px-4 py-2.5"
    >
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {hint ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Per-model description for the layout model select: shows the description
 * of the currently selected model, falling back to the generic pool note for
 * models without a dedicated entry. */
function layoutModelDescription(
  dir: string,
  t: (key: TranslationKey) => string,
): string {
  const key = `settings.layoutModelDesc.${dir}` as TranslationKey;
  return key in translations.en ? t(key) : t("settings.ocrLayoutModelDesc");
}

function OcrSettingsPanel({
  vendors,
  onChange,
  ocrMode,
  onOcrModeChange,
  loading,
  ocrModelSize,
  onOcrModelSizeChange,
  ocrLayoutMode,
  onOcrLayoutModeChange,
  ocrLayoutModel,
  onOcrLayoutModelChange,
  layoutModels,
  layoutScoreThreshold,
  onLayoutScoreThresholdChange,
  layoutDropHeaderFooter,
  onLayoutDropHeaderFooterChange,
  ocrTextCleanup,
  onOcrTextCleanupChange,
  aiOcrPrompt,
  onAiOcrPromptChange,
  drawTablePrompt,
  onDrawTablePromptChange,
}: {
  vendors: VendorForm[];
  onChange: (updater: SetStateAction<VendorForm[]>) => void;
  ocrMode: OcrMode;
  onOcrModeChange: (v: OcrMode) => void;
  loading: boolean;
  ocrModelSize: OcrModelSize;
  onOcrModelSizeChange: (v: OcrModelSize) => void;
  ocrLayoutMode: LayoutMode;
  onOcrLayoutModeChange: (v: LayoutMode) => void;
  ocrLayoutModel: string;
  onOcrLayoutModelChange: (v: string) => void;
  layoutModels: LayoutModelInfo[];
  layoutScoreThreshold: number;
  onLayoutScoreThresholdChange: (v: number) => void;
  layoutDropHeaderFooter: boolean;
  onLayoutDropHeaderFooterChange: (v: boolean) => void;
  ocrTextCleanup: boolean;
  onOcrTextCleanupChange: (v: boolean) => void;
  aiOcrPrompt: string;
  onAiOcrPromptChange: (v: string) => void;
  drawTablePrompt: string;
  onDrawTablePromptChange: (v: string) => void;
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
      <SubSection label={t("settings.subEngine")} first />
      <Panel>
        <SettingRow
          label={t("settings.ocrEnabled")}
          description={t(`settings.ocrMode.${ocrMode}Desc`)}
        >
          <Select
            value={ocrMode}
            onValueChange={(v) => onOcrModeChange(v as OcrMode)}
            disabled={loading}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="forceLocal">
                {t("settings.ocrMode.forceLocal")}
              </SelectItem>
              <SelectItem value="forceAi">
                {t("settings.ocrMode.forceAi")}
              </SelectItem>
              <SelectItem value="nonTextLocal">
                {t("settings.ocrMode.nonTextLocal")}
              </SelectItem>
              <SelectItem value="nonTextAi">
                {t("settings.ocrMode.nonTextAi")}
              </SelectItem>
              <SelectItem value="disabled">
                {t("settings.ocrMode.disabled")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </Panel>

      <Panel>
        <SettingRow label={t("settings.ocrModelSize")}>
          <Select
            value={ocrModelSize}
            onValueChange={(v) => onOcrModelSizeChange(v as OcrModelSize)}
            disabled={loading}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tiny">
                {t("settings.ocrModelSize.tiny")}
              </SelectItem>
              <SelectItem value="small">
                {t("settings.ocrModelSize.small")}
              </SelectItem>
              <SelectItem value="medium">
                {t("settings.ocrModelSize.medium")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </Panel>

      <Panel>
        <SettingRow
          label={t("settings.ocrTextCleanup")}
          description={t("settings.ocrTextCleanupDesc")}
        >
          <Switch
            checked={ocrTextCleanup}
            onCheckedChange={onOcrTextCleanupChange}
            disabled={loading}
          />
        </SettingRow>
      </Panel>

      {/* Layout analysis (docs/design/00016): off / paddle. The
          model + sub-options only expand for the paddle tier. */}
      <SubSection label={t("settings.subLayout")} />
      <Panel>
        <SettingRow
          label={t("settings.ocrLayoutMode")}
          description={t(`settings.ocrLayoutMode.${ocrLayoutMode}Desc`)}
        >
          <Select
            value={ocrLayoutMode}
            onValueChange={(v) => onOcrLayoutModeChange(v as LayoutMode)}
            disabled={loading}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">
                {t("settings.ocrLayoutMode.off")}
              </SelectItem>
              <SelectItem value="paddle">
                {t("settings.ocrLayoutMode.paddle")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        {ocrLayoutMode === "paddle" ? (
          <>
            <SettingRow
              label={t("settings.ocrLayoutModel")}
              description={layoutModelDescription(ocrLayoutModel, t)}
            >
              <Select
                value={ocrLayoutModel}
                onValueChange={(v) => onOcrLayoutModelChange(v)}
                disabled={loading}
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {layoutModels.length === 0 ? (
                    <SelectItem value={ocrLayoutModel} disabled>
                      {ocrLayoutModel}
                    </SelectItem>
                  ) : (
                    layoutModels.map((m) => (
                      <SelectItem key={m.dir} value={m.dir}>
                        {m.displayName}
                        {m.available
                          ? ""
                          : ` (${t("settings.layoutModelMissing")})`}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow
              label={t("settings.layoutScoreThreshold")}
              description={t("settings.layoutScoreThresholdDesc")}
            >
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                className="w-24"
                value={
                  Number.isFinite(layoutScoreThreshold)
                    ? layoutScoreThreshold
                    : ""
                }
                onChange={(e) =>
                  onLayoutScoreThresholdChange(Number(e.target.value))
                }
                disabled={loading}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.layoutDropHeaderFooter")}
              description={t("settings.layoutDropHeaderFooterDesc")}
            >
              <Switch
                checked={layoutDropHeaderFooter}
                onCheckedChange={onLayoutDropHeaderFooterChange}
                disabled={loading}
              />
            </SettingRow>
          </>
        ) : null}
      </Panel>

      <SubSection label={t("settings.subVendors")} />

      {loading ? (
        <div className="space-y-2 px-4 py-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : vendors.length === 0 ? (
        <div className="mx-4 mb-3 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 bg-muted/20 px-6 py-8 text-center">
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

      {vendors.length > 0 ? (
        <div className="flex items-center px-4 py-3">
          <Button variant="secondary" size="sm" onClick={addVendor}>
            <Plus />
            {t("settings.addVendor")}
          </Button>
        </div>
      ) : null}

      {/* Custom prompts for the remote AI vision paths (empty = built-in
          default). Both are collapsible so the OCR page stays tidy. */}
      <SubSection
        label={t("settings.subPrompts")}
        hint={t("settings.subPromptsHint")}
      />
      <Panel>
        <PromptTextarea
          title={t("settings.aiOcrPrompt")}
          description={t("settings.aiOcrPromptDesc")}
          value={aiOcrPrompt}
          onChange={onAiOcrPromptChange}
          placeholder={t("settings.aiOcrPromptPlaceholder")}
          disabled={loading}
        />
        <PromptTextarea
          title={t("settings.drawTablePrompt")}
          description={t("settings.drawTablePromptDesc")}
          value={drawTablePrompt}
          onChange={onDrawTablePromptChange}
          placeholder={t("settings.drawTablePromptPlaceholder")}
          disabled={loading}
        />
      </Panel>
    </>
  );
}

/**
 * Collapsible setting row backed by a textarea. Collapsed by default so the
 * long custom prompts do not dominate the OCR settings page.
 */
function PromptTextarea({
  title,
  description,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  title: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div
      data-setting-row
      data-setting-label={title}
      data-setting-desc={description}
      className="px-4 py-3"
    >
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 text-left transition-colors"
      >
        <ChevronDown
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
        <span className="min-w-0 flex-1 space-y-0.5">
          <Label className="cursor-pointer">{title}</Label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </span>
        {value.trim().length > 0 ? (
          <span className="mt-0.5 shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            {t("settings.customPrompt")}
          </span>
        ) : null}
      </button>
      {open ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="mt-2"
          rows={4}
        />
      ) : null}
    </div>
  );
}

const THREAD_MIN = 1;
const THREAD_MAX = 16;

function clampThread(n: number): number {
  return Math.min(THREAD_MAX, Math.max(THREAD_MIN, Math.round(n)));
}

/** OCR threads allows 0 (= auto-detect) in addition to 1–16. */
function clampOcrThreads(n: number): number {
  return Math.min(THREAD_MAX, Math.max(0, Math.round(n)));
}

function ThreadSettingsPanel({
  value,
  onChange,
  localOcrThreads,
  onLocalOcrThreadsChange,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  localOcrThreads: number;
  onLocalOcrThreadsChange: (n: number) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  return (
    <Panel>
      <SettingRow
        label={t("settings.maxConcurrent")}
        description={t("settings.threadsHint2")}
        htmlFor="settings-threads-input"
      >
        <Input
          id="settings-threads-input"
          type="number"
          inputMode="numeric"
          min={THREAD_MIN}
          max={THREAD_MAX}
          step={1}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.valueAsNumber)}
          disabled={disabled}
          placeholder={t("settings.threadPlaceholder")}
          className="w-24 text-right"
        />
      </SettingRow>
      <SettingRow
        label={t("settings.localOcrThreads")}
        description={t("settings.localOcrThreadsHint")}
        htmlFor="settings-ocr-threads-input"
      >
        <Input
          id="settings-ocr-threads-input"
          type="number"
          inputMode="numeric"
          min={0}
          max={THREAD_MAX}
          step={1}
          value={Number.isFinite(localOcrThreads) ? localOcrThreads : ""}
          onChange={(e) => onLocalOcrThreadsChange(e.target.valueAsNumber)}
          disabled={disabled}
          placeholder={t("settings.localOcrThreadsPlaceholder")}
          className="w-24 text-right"
        />
      </SettingRow>
    </Panel>
  );
}

/**
 * Global hotkey that triggers screenshot recognition. Recorded by pressing a
 * key combination; stored in the accelerator syntax understood by the backend
 * (`Ctrl+Shift+KeyA`, `F8`, ...); empty disables the hotkey. Also carries the
 * post-recognition behaviours (result popup + auto-copy).
 */
function SnipSettingsPanel({
  value,
  onChange,
  resultPopup,
  onResultPopupChange,
  autoCopy,
  onAutoCopyChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  resultPopup: boolean;
  onResultPopupChange: (v: boolean) => void;
  autoCopy: boolean;
  onAutoCopyChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  return (
    <>
      <Panel>
        <SettingRow
          label={t("settings.screenshotHotkey")}
          description={t("settings.screenshotHotkeyHint")}
        >
          <HotkeyInput value={value} onChange={onChange} disabled={disabled} />
        </SettingRow>
        <SettingRow
          label={t("settings.snipResultPopup")}
          description={t("settings.snipResultPopupDesc")}
        >
          <Switch
            checked={resultPopup}
            onCheckedChange={onResultPopupChange}
            disabled={disabled}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.snipAutoCopy")}
          description={t("settings.snipAutoCopyDesc")}
        >
          <Switch
            checked={autoCopy}
            onCheckedChange={onAutoCopyChange}
            disabled={disabled}
          />
        </SettingRow>
      </Panel>
    </>
  );
}

/**
 * Glassmorphism appearance of the two translucent windows. The blur toggle is
 * shared by the main and result windows; each window keeps its own background
 * opacity slider (independent settings).
 */
function GlassSettingsPanel({
  blurEnabled,
  onBlurEnabledChange,
  resultOpacity,
  onResultOpacityChange,
  mainOpacity,
  onMainOpacityChange,
  disabled,
}: {
  blurEnabled: boolean;
  onBlurEnabledChange: (v: boolean) => void;
  resultOpacity: number;
  onResultOpacityChange: (v: number) => void;
  mainOpacity: number;
  onMainOpacityChange: (v: number) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  const rangeClass =
    "h-2 w-32 cursor-pointer appearance-none rounded-full bg-border accent-primary " +
    "[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 " +
    "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full " +
    "[&::-webkit-slider-thumb]:bg-[#6FCF97] [&::-webkit-slider-thumb]:shadow-sm " +
    "[&::-webkit-slider-thumb]:dark:bg-[#446351]";

  return (
    <Panel>
      <SettingRow
        label={t("settings.glassBlur")}
        description={t("settings.glassBlurDesc")}
      >
        <Switch
          checked={blurEnabled}
          onCheckedChange={onBlurEnabledChange}
          disabled={disabled}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.mainWindowOpacity")}
        description={t("settings.mainWindowOpacityDesc")}
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={mainOpacity}
            onChange={(e) => onMainOpacityChange(Number(e.target.value))}
            disabled={disabled}
            className={rangeClass}
          />
          <span className="w-8 text-right text-sm tabular-nums text-muted-foreground select-none">
            {mainOpacity}%
          </span>
        </div>
      </SettingRow>
      <SettingRow
        label={t("settings.snipResultOpacity")}
        description={t("settings.snipResultOpacityDesc")}
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={resultOpacity}
            onChange={(e) => onResultOpacityChange(Number(e.target.value))}
            disabled={disabled}
            className={rangeClass}
          />
          <span className="w-8 text-right text-sm tabular-nums text-muted-foreground select-none">
            {resultOpacity}%
          </span>
        </div>
      </SettingRow>
    </Panel>
  );
}

function ParagraphModeSettingsPanel({
  value,
  onChange,
  disabled,
}: {
  value: ParagraphMode;
  onChange: (v: ParagraphMode) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  const MODE_OPTIONS: {
    value: ParagraphMode;
    labelKey: TranslationKey;
    descKey: TranslationKey;
  }[] = [
    {
      value: "guided",
      labelKey: "settings.paragraphMode.guided",
      descKey: "settings.paragraphMode.guidedDesc",
    },
    {
      value: "smart",
      labelKey: "settings.paragraphMode.smart",
      descKey: "settings.paragraphMode.smartDesc",
    },
    {
      value: "none",
      labelKey: "settings.paragraphMode.none",
      descKey: "settings.paragraphMode.noneDesc",
    },
  ];

  return (
    <Panel>
      <SettingRow
        label={t("settings.paragraphMode")}
        description={t(
          MODE_OPTIONS.find((o) => o.value === value)?.descKey ??
            MODE_OPTIONS[0].descKey,
        )}
      >
        <Select
          value={value}
          onValueChange={(v) => onChange(v as ParagraphMode)}
          disabled={disabled}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </Panel>
  );
}

function TextSepSettingsPanel({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  const SEPARATOR_OPTIONS = [
    { label: "| (pipe)", value: "|" },
    { label: "' ' (space)", value: " " },
    { label: ", (comma)", value: "," },
    { label: "\\t (tab)", value: "\t" },
    { label: "^ (caret)", value: "^" },
  ];

  return (
    <Panel className="border-t border-border/60">
      <SettingRow
        label={t("settings.textSeparator")}
        description={t("settings.textSeparatorDesc")}
      >
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEPARATOR_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </Panel>
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
    <Panel className="border-t border-border/60">
      <SettingRow
        label={t("settings.tray")}
        description={t("settings.trayDesc")}
      >
        <Switch
          checked={value}
          onCheckedChange={onChange}
          disabled={disabled}
        />
      </SettingRow>
    </Panel>
  );
}

/**
 * Release check settings (docs/design/00020): the startup check toggle plus the
 * running version, a manual check and the "skip this version" escape hatch.
 * The check only reports - the installer is downloaded from GitHub by hand.
 */
function UpdateSettingsPanel({
  autoCheck,
  onAutoCheckChange,
  skippedVersion,
  onSkippedCleared,
  disabled,
}: {
  autoCheck: boolean;
  onAutoCheckChange: (v: boolean) => void;
  skippedVersion: string;
  onSkippedCleared: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    void getUpdateState()
      .then((state) => {
        if (alive) setSnapshot(state);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function clearSkipped() {
    try {
      await clearSkippedVersion();
      onSkippedCleared();
      toast.success(t("update.skippedCleared"));
    } catch (e) {
      toast.error(t("toast.saveFailed"), { description: String(e) });
    }
  }

  const currentVersion = snapshot?.currentVersion ?? "";
  const available =
    snapshot?.phase === "available" && snapshot.version
      ? snapshot.version
      : null;

  return (
    <Panel>
      <SettingRow
        label={t("update.currentVersion")}
        description={
          available ? t("update.available", { version: available }) : undefined
        }
      >
        <span className="text-sm tabular-nums text-muted-foreground">
          {currentVersion ? `v${currentVersion}` : "-"}
        </span>
      </SettingRow>

      <SettingRow
        label={t("update.autoCheck")}
        description={t("update.autoCheckDesc")}
      >
        <Switch
          checked={autoCheck}
          onCheckedChange={onAutoCheckChange}
          disabled={disabled}
        />
      </SettingRow>

      {skippedVersion ? (
        <SettingRow
          label={t("update.skippedLabel")}
          description={`v${skippedVersion}`}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => void clearSkipped()}
          >
            {t("update.clearSkipped")}
          </Button>
        </SettingRow>
      ) : null}
    </Panel>
  );
}

/** i18n keys for the backend's model group ids. */
const MODEL_GROUP_KEYS: Record<string, TranslationKey> = {
  "ocr.tiny": "settings.modelGroupOcrTiny",
  "ocr.small": "settings.modelGroupOcrSmall",
  "ocr.medium": "settings.modelGroupOcrMedium",
  "layout.PP-DocLayoutV3": "settings.modelGroupLayout",
};

/** `3.1 MB` / `812 KB`. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Model files (docs/design/00022): models are not shipped with the installer,
 * so every group can be downloaded from ModelScope here - or fed in by dropping
 * files / picking a folder. The backend verifies size + SHA-256 before a file
 * is accepted, so a wrong or truncated file is reported instead of silently
 * breaking OCR.
 */
function ModelsPanel() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ModelsSnapshot | null>(null);
  const [progress, setProgress] = useState<ModelProgress | null>(null);
  const [busyGroup, setBusyGroup] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const next = await listModels().catch(() => null);
    if (next) setSnapshot(next);
  }, []);

  useEffect(() => {
    void refresh();
    const unlisten = onModelProgress((next) => setProgress(next));
    return () => {
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [refresh]);

  /** Drops must stay inert while another settings section is on screen. */
  function panelVisible(): boolean {
    return panelRef.current?.offsetParent !== null;
  }

  async function importPaths(paths: string[]) {
    if (paths.length === 0) return;
    setImporting(true);
    try {
      const result: LocalImportResult = await addLocalModels(paths);
      await refresh();
      if (result.imported.length > 0) {
        toast.success(
          t("settings.modelImported", { count: result.imported.length }),
        );
      }
      if (result.failed.length > 0) {
        toast.error(
          t("settings.modelImportFailed", { count: result.failed.length }),
          { description: result.failed.join("\n") },
        );
      }
      if (result.ignored.length > 0) {
        toast.info(
          t("settings.modelIgnored", { count: result.ignored.length }),
        );
      }
    } catch (e) {
      toast.error(t("settings.modelImportError"), { description: String(e) });
    } finally {
      setImporting(false);
    }
  }

  // Whole-window drag & drop: real paths come from Tauri, not the HTML5 API.
  useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const { type } = event.payload;
        if (type === "leave") {
          setDragging(false);
          return;
        }
        if (type === "over" || type === "enter") {
          if (panelVisible()) setDragging(true);
          return;
        }
        if (type !== "drop") return;
        setDragging(false);
        if (panelVisible()) void importPaths(event.payload.paths);
      })
      .then((fn) => {
        if (stopped) fn();
        else unlisten = fn;
      });
    return () => {
      stopped = true;
      if (unlisten) unlisten();
    };
    // `importPaths` is recreated per render but only uses stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function download(group: string) {
    setBusyGroup(group);
    try {
      const next = await downloadModels(group);
      setSnapshot(next);
      setProgress(null);
      toast.success(t("settings.modelDownloaded"));
    } catch (e) {
      toast.error(t("settings.modelDownloadFailed"), {
        description: String(e),
      });
    } finally {
      setBusyGroup(null);
      void refresh();
    }
  }

  async function pick(useFolder: boolean) {
    try {
      if (useFolder) {
        const dir = await openFileDialog({ directory: true, multiple: false });
        if (dir) await importPaths([dir as string]);
      } else {
        const files = await openFileDialog({
          multiple: true,
          filters: [
            { name: "Model files", extensions: ["mnn", "json", "txt"] },
          ],
        });
        if (files) await importPaths(Array.isArray(files) ? files : [files]);
      }
    } catch {
      /* dialog cancelled */
    }
  }

  const groups: ModelGroupDto[] = snapshot?.groups ?? [];
  const activeGroup = progress?.group ?? null;
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div ref={panelRef} className="space-y-2 pb-2">
      <Panel>
        {groups.map((group) => {
          const running = busyGroup === group.id || activeGroup === group.id;
          return (
            <div
              key={group.id}
              data-setting-row
              data-setting-label={t(
                MODEL_GROUP_KEYS[group.id] ?? "settings.modelFiles",
              )}
              className="flex flex-col gap-2 px-4 py-3"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 space-y-0.5">
                  <Label>
                    {t(MODEL_GROUP_KEYS[group.id] ?? "settings.modelFiles")}
                  </Label>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatSize(group.totalBytes)} ·{" "}
                    {group.files.map((file) => file.name).join(", ")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={cn(
                      "text-xs",
                      group.installed
                        ? "text-muted-foreground"
                        : "text-warning",
                    )}
                  >
                    {group.installed
                      ? t("settings.modelInstalled")
                      : t("settings.modelNotInstalled")}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={running || importing}
                    onClick={() => void download(group.id)}
                  >
                    {group.installed
                      ? t("settings.modelRedownload")
                      : t("settings.modelDownload")}
                  </Button>
                </div>
              </div>
              {running && percent !== null ? (
                <div className="space-y-1">
                  <Progress value={percent} className="h-1.5" />
                  <p className="text-[11px] text-muted-foreground">
                    {t("settings.modelDownloading", { percent })}
                    {progress?.file ? ` · ${progress.file}` : ""}
                  </p>
                </div>
              ) : null}
            </div>
          );
        })}
      </Panel>

      <div
        className={cn(
          "mx-4 flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-4 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border/60",
        )}
      >
        <p className="text-xs text-muted-foreground">
          {t("settings.modelDragHint")}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={importing}
            onClick={() => void pick(false)}
          >
            {t("settings.modelPickFiles")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={importing}
            onClick={() => void pick(true)}
          >
            {t("settings.modelPickFolder")}
          </Button>
        </div>
        {snapshot?.root ? (
          <p className="break-all text-[11px] text-muted-foreground/80">
            {t("settings.modelTargetHint", { path: snapshot.root })}
          </p>
        ) : null}
      </div>
    </div>
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

/** Friendly label for one token of an accelerator (`Ctrl`, `A`, `F8`, ...). */
function hotkeyTokenLabel(part: string): string {
  const lower = part.toLowerCase();
  if (lower === "ctrl" || lower === "control") return "Ctrl";
  if (lower === "alt" || lower === "option") return "Alt";
  if (lower === "shift") return "Shift";
  if (lower === "super" || lower === "meta" || lower === "win") return "Win";
  if (/^key[a-z]$/i.test(part)) return part.slice(3).toUpperCase();
  if (/^digit\d$/i.test(part)) return part.slice(5);
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
    ArrowUp: "\u2191",
    ArrowDown: "\u2193",
    ArrowLeft: "\u2190",
    ArrowRight: "\u2192",
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
          "flex h-9 w-48 items-center gap-1.5 rounded-lg border px-3 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
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
      </button>
    </div>
  );
}

function DrawSettingsPanel({
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
    <Panel>
      <SettingRow
        label={t("settings.cacheExtracted")}
        description={t("settings.cacheExtractedDesc")}
      >
        <Switch
          checked={value}
          onCheckedChange={onChange}
          disabled={disabled}
        />
      </SettingRow>
    </Panel>
  );
}

function ExcelSettingsPanel({
  value,
  onChange,
  stripMdSyntax,
  onStripMdSyntaxChange,
  writeNumeric,
  onWriteNumericChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  stripMdSyntax: boolean;
  onStripMdSyntaxChange: (v: boolean) => void;
  writeNumeric: boolean;
  onWriteNumericChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  return (
    <Panel>
      <SettingRow
        label={t("settings.excelTablesOnly")}
        description={t("settings.excelTablesOnlyDesc")}
      >
        <Switch
          checked={value}
          onCheckedChange={onChange}
          disabled={disabled}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.stripMdSyntax")}
        description={t("settings.stripMdSyntaxDesc")}
      >
        <Switch
          checked={stripMdSyntax}
          onCheckedChange={onStripMdSyntaxChange}
          disabled={disabled}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.writeNumeric")}
        description={t("settings.writeNumericDesc")}
      >
        <Switch
          checked={writeNumeric}
          onCheckedChange={onWriteNumericChange}
          disabled={disabled}
        />
      </SettingRow>
    </Panel>
  );
}

/** Export / import the whole configuration as a JSON file. */
function BackupPanel({
  busy,
  onImported,
}: {
  busy: boolean;
  onImported: () => void;
}) {
  const { t } = useI18n();
  const [working, setWorking] = useState(false);
  const disabled = busy || working;

  async function handleExport(includeSecrets: boolean) {
    const path = await saveFileDialog({
      defaultPath: "doccraft-config.json",
      filters: [{ name: t("filter.configFiles"), extensions: ["json"] }],
    });
    if (!path) return;
    setWorking(true);
    try {
      await exportConfig(path, includeSecrets);
      toast.success(t("toast.configExported"), { description: path });
    } catch (e) {
      toast.error(t("toast.exportFailed"), { description: String(e) });
    } finally {
      setWorking(false);
    }
  }

  async function handleImport() {
    const file = await openFileDialog({
      multiple: false,
      filters: [{ name: t("filter.configFiles"), extensions: ["json"] }],
    });
    if (!file || typeof file !== "string") return;
    setWorking(true);
    try {
      const result = await importConfig(file);
      // Let other views re-sync anything derived from app settings.
      window.dispatchEvent(new Event("doccraft:settings-saved"));
      toast.success(
        t("toast.configImported", { vendors: result.vendorsImported }) +
          (result.settingsApplied ? t("toast.configImportedSettings") : ""),
        { description: file },
      );
      onImported();
    } catch (e) {
      toast.error(t("toast.importFailed"), { description: String(e) });
    } finally {
      setWorking(false);
    }
  }

  return (
    <Panel>
      <SettingRow
        label={t("settings.exportConfig")}
        description={t("settings.exportConfigDesc")}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" disabled={disabled}>
              {working ? <Loader2 className="animate-spin" /> : <Download />}
              {t("settings.exportConfig")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-full">
            <DropdownMenuItem onClick={() => void handleExport(false)}>
              {t("settings.exportWithoutKeys")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => void handleExport(true)}
            >
              {t("settings.exportWithKeys")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SettingRow>
      <SettingRow
        label={t("settings.importConfig")}
        description={t("settings.importConfigDesc")}
      >
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => void handleImport()}
        >
          <Upload />
          {t("settings.importConfig")}
        </Button>
      </SettingRow>
    </Panel>
  );
}

/** Read-only local usage statistics card (this month / today / all time). */
function UsageStatsPanel({
  stats,
  busy,
  onCleared,
}: {
  stats: UsageStats | null;
  busy: boolean;
  /** Called after the local usage log has been deleted, to reset the card. */
  onCleared?: () => void;
}) {
  const { t } = useI18n();
  const [clearing, setClearing] = useState(false);

  async function handleClear() {
    setClearing(true);
    try {
      await clearUsageStats();
      onCleared?.();
      toast.success(t("toast.statsCleared"));
    } catch (e) {
      toast.error(t("toast.statsClearFailed"), { description: String(e) });
    } finally {
      setClearing(false);
    }
  }

  return (
    <Panel>
      <UsagePeriodBlock
        title={t("settings.statsToday")}
        period={stats?.today}
        busy={busy}
      />
      <UsagePeriodBlock
        title={t("settings.statsMonth")}
        period={stats?.month}
        busy={busy}
      />
      <UsagePeriodBlock
        title={t("settings.statsTotal")}
        period={stats?.total}
        busy={busy}
      />
      <SettingRow
        label={t("settings.clearStats")}
        description={t("settings.clearStatsDesc")}
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleClear()}
          disabled={busy || clearing}
        >
          {clearing ? <Loader2 className="animate-spin" /> : <Trash2 />}
          {t("settings.clearStats")}
        </Button>
      </SettingRow>
    </Panel>
  );
}

function UsagePeriodBlock({
  title,
  period,
  busy,
}: {
  title: string;
  period: UsagePeriodStats | undefined;
  busy: boolean;
}) {
  const { t } = useI18n();
  const pdfOcrRatio =
    period && period.pdfPageCount > 0
      ? Math.round((period.pdfOcrPageCount / period.pdfPageCount) * 100)
      : null;
  const ocrRatio =
    pdfOcrRatio ??
    (period && period.pageCount > 0
      ? Math.round((period.ocrPageCount / period.pageCount) * 100)
      : 0);
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {busy || !period ? (
          <Skeleton className="h-4 w-16" />
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("settings.statsDuration")}{" "}
            <span className="font-medium tabular-nums text-foreground">
              {formatDuration(period.totalMs)}
            </span>
          </span>
        )}
      </div>
      {busy || !period ? (
        <div className="flex gap-4">
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-14" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3 sm:gap-y-1.5">
          <StatCell
            label={t("settings.statsFiles")}
            value={period.fileCount}
            sub={t("settings.statsFilesSplit", {
              pdf: period.pdfFileCount,
              image: period.imageFileCount,
            })}
          />
          <StatCell
            label={t("settings.statsPages")}
            value={period.pageCount}
            sub={t("settings.statsPagesSplit", {
              pdf: period.pdfPageCount,
              image: period.imageFileCount,
            })}
          />
          <StatCell
            label={t("settings.statsOcrPages")}
            value={`${period.ocrPageCount} · ${ocrRatio}%`}
            sub={t("settings.statsOcrSplit", {
              local: period.localOcrPageCount,
              ai: period.aiOcrPageCount,
            })}
          />
        </div>
      )}
    </div>
  );
}

function StatCell({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
      {sub ? (
        <p className="truncate text-[11px] text-muted-foreground">{sub}</p>
      ) : null}
    </div>
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
  const [open, setOpen] = useState(!vendor.apiKeySet);
  return (
    <div className="mx-4 my-2 overflow-hidden rounded-xl border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 select-none"
      >
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">
            {v.name || (
              <span className="text-muted-foreground">
                {t("settings.vendorName")}
              </span>
            )}
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {v.baseUrl || "-"}
          </span>
        </span>
        {v.models.length > 0 ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {v.models.length}
          </span>
        ) : null}
        {v.apiKeySet && !v.clearApiKey ? (
          <span className="flex shrink-0 items-center gap-1 rounded-md bg-success-muted px-1.5 py-0.5 text-[11px] font-medium text-success">
            <ShieldCheck className="size-3" />
            {t("settings.keySaved")}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="space-y-4 px-3 py-3">
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
                            ? "text-warning hover:text-warning"
                            : "text-muted-foreground"
                        }
                      >
                        <Star className={m.default ? "fill-current" : ""} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("settings.defaultModel")}
                    </TooltipContent>
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
        </div>
      ) : null}
    </div>
  );
}
