import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { ConvertToolbar } from "./convert-toolbar";
import { PdfPreview } from "./pdf-preview";
import { PreviewPane } from "./preview-pane";
import { convertWithOcr } from "./render-pdf-pages";
import { StatusBar } from "./status-bar";
import { convertPdf, detectPdf, exportMarkdown } from "@/lib/ipc";
import type { ConvertResult, DetectResult } from "@/lib/types";

interface ConvertWorkspaceProps {
  filePath: string;
  fileName: string;
  /** Provide a finished conversion to open it directly (e.g. preview a batch item). */
  initialResult?: ConvertResult | null;
  /**
   * Called after a successful (re)conversion within this workspace.
   * Lets a parent keep its own file list in sync.
   */
  onConverted?: (result: ConvertResult) => void;
  /** Remove / clear the current file. */
  onClear?: () => void;
}

export function ConvertWorkspace({
  filePath,
  fileName,
  initialResult,
  onConverted,
  onClear,
}: ConvertWorkspaceProps) {
  const [detecting, setDetecting] = useState(false);
  const [converting, setConverting] = useState(false);
  const [detect, setDetect] = useState<DetectResult | null>(initialResult ?? null);
  const [result, setResult] = useState<ConvertResult | null>(initialResult ?? null);

  const busy = detecting || converting;

  useEffect(() => {
    if (initialResult) {
      setDetect(initialResult);
      setResult(initialResult);
      return;
    }
    let cancelled = false;
    setDetecting(true);
    detectPdf(filePath)
      .then((d) => {
        if (!cancelled) setDetect(d);
      })
      .catch((e) => toast.error("检测失败", { description: String(e) }))
      .finally(() => {
        if (!cancelled) setDetecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, initialResult]);

  async function handleConvert() {
    if (!filePath) return;
    setConverting(true);
    try {
      // Pages that need OCR are streamed one at a time; pure-text pages stay
      // local. Everything is merged back in document order by the backend.
      const needOcr = detect?.pagesNeedingOcr ?? [];
      const r =
        needOcr.length > 0
          ? await convertWithOcr(filePath, needOcr)
          : await convertPdf(filePath);
      setResult(r);
      setDetect(r);
      onConverted?.(r);
      toast.success("转换完成");
    } catch (e) {
      toast.error("转换失败", { description: String(e) });
    } finally {
      setConverting(false);
    }
  }

  async function handleExport() {
    if (!result) return;
    const base = fileName.replace(/\.pdf$/i, "") || "document";
    const target = await save({
      defaultPath: `${base}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof target !== "string") return;
    try {
      await exportMarkdown(target, result.markdown);
      toast.success("已导出", { description: target });
    } catch (e) {
      toast.error("导出失败", { description: String(e) });
    }
  }

  return (
    <>
      <ConvertToolbar
        name={fileName}
        path={filePath}
        busy={busy}
        converting={converting}
        onConvert={handleConvert}
        onClear={onClear}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
        <PdfPreview path={filePath} className="min-h-[280px]" />

        <div className="min-h-0 min-w-0">
          {result ? (
            <PreviewPane
              markdown={result.markdown}
              processingTimeMs={result.processingTimeMs}
              onExport={handleExport}
              className="h-full"
            />
          ) : null}
        </div>
      </div>

      <div className="-mb-3">
        <StatusBar result={detect} loading={detecting} />
      </div>
    </>
  );
}