import { FileText } from "lucide-react";

interface DragOverlayProps {
  title?: string;
  hint?: string;
}

export function DragOverlay({
  title = "松开以加载 PDF",
  hint = "支持整个窗口范围内拖放",
}: DragOverlayProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-primary bg-background/80 backdrop-blur-sm">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <FileText className="size-7" />
      </span>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}