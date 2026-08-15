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
  { badgeClass: string; icon: LucideIcon }
> = {
  TextBased: {
    badgeClass:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:border-emerald-500/40 dark:text-emerald-400",
    icon: FileText,
  },
  Mixed: {
    badgeClass:
      "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:border-amber-500/40 dark:text-amber-400",
    icon: Layers,
  },
  Scanned: {
    badgeClass:
      "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:border-sky-500/40 dark:text-sky-400",
    icon: ScanSearch,
  },
  ImageBased: {
    badgeClass:
      "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:border-sky-500/40 dark:text-sky-400",
    icon: FileQuestion,
  },
};
