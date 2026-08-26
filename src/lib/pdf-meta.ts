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
      "border-success/30 bg-success-muted text-success dark:border-success/40",
    icon: FileText,
  },
  Mixed: {
    badgeClass:
      "border-warning/30 bg-warning-muted text-warning dark:border-warning/40",
    icon: Layers,
  },
  Scanned: {
    badgeClass: "border-info/30 bg-info-muted text-info dark:border-info/40",
    icon: ScanSearch,
  },
  ImageBased: {
    badgeClass: "border-info/30 bg-info-muted text-info dark:border-info/40",
    icon: FileQuestion,
  },
};
