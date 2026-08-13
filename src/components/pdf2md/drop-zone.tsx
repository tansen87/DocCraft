import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileText } from "lucide-react";

import { cn } from "@/lib/utils";

interface DropZoneProps {
  onFiles: (paths: string[]) => void;
  multiple?: boolean;
  className?: string;
  /** Accepted extensions without a leading dot, e.g. ["pdf"]. */
  extensions?: string[];
  /** Dialog filter label shown in the file picker. */
  filterLabel?: string;
  /** Primary title, e.g. "将 PDF 拖到窗口任意位置". */
  title?: string;
  /** Secondary hint text. */
  subtitle?: string;
  /** Support line, e.g. "支持 .pdf · 单文件". */
  supportText?: string;
}

export function DropZone({
  onFiles,
  multiple = false,
  className,
  extensions = ["pdf"],
  filterLabel = "PDF 文档",
  title = "将 PDF 拖到窗口任意位置",
  subtitle = "或点击选择文件",
  supportText = `支持 .${extensions.join(" / .")} ${multiple ? "· 可多选" : "· 单文件"}`,
}: DropZoneProps) {
  const [hover, setHover] = useState(false);

  async function pick() {
    const file = (await open({
      multiple,
      filters: [{ name: filterLabel, extensions }],
    })) as string | string[] | null;
    const paths = Array.isArray(file) ? file : file ? [file] : [];
    if (paths.length > 0) onFiles(paths);
  }

  return (
    <button
      type="button"
      onClick={pick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cn(
        "flex w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-all",
        hover
          ? "border-primary bg-primary/5 shadow-md"
          : "border-border hover:border-primary/40 hover:bg-muted/40",
        className,
      )}
    >
      <span
        className={cn(
          "flex size-14 items-center justify-center rounded-2xl transition-colors",
          hover ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        <FileText className="size-7" />
      </span>
      <span className="space-y-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
          {subtitle}
        </span>
      </span>
      <span className="text-xs text-muted-foreground/70">{supportText}</span>
    </button>
  );
}