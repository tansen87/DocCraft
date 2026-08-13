import {
  FileQuestion,
  Layers,
  ScanSearch,
  type LucideIcon,
  FileText,
} from "lucide-react";
import type { PdfType } from "./types";

export const pdfTypeMeta: Record<
  PdfType,
  { label: string; hint: string; badgeClass: string; icon: LucideIcon }
> = {
  TextBased: {
    label: "文本型",
    hint: "无需 OCR, 本地直接转换",
    badgeClass:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:border-emerald-500/40 dark:text-emerald-400",
    icon: FileText,
  },
  Mixed: {
    label: "混合型",
    hint: "部分页面为扫描内容, 需要 OCR",
    badgeClass:
      "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:border-amber-500/40 dark:text-amber-400",
    icon: Layers,
  },
  Scanned: {
    label: "扫描件",
    hint: "需要配置 OCR API(设置页)",
    badgeClass:
      "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:border-sky-500/40 dark:text-sky-400",
    icon: ScanSearch,
  },
  ImageBased: {
    label: "图片版",
    hint: "需要配置 OCR API(设置页)",
    badgeClass:
      "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:border-sky-500/40 dark:text-sky-400",
    icon: FileQuestion,
  },
};
