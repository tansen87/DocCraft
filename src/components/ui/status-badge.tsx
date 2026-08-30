import { Check, Clock, Loader2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

type Status =
  | "queued"
  | "converting"
  | "analyzing"
  | "ready"
  | "done"
  | "error";

const STATUS_TOKEN_MAP: Record<string, string> = {
  converting: "bg-info-muted border-info/30 text-info dark:border-info/40",
  analyzing: "bg-info-muted border-info/30 text-info dark:border-info/40",
  done: "bg-success-muted border-success/30 text-success dark:border-success/40",
  ready:
    "bg-success-muted border-success/30 text-success dark:border-success/40",
};

function StatusBadge({
  status,
  error,
  readyLabel,
}: {
  status: Status;
  error?: string;
  /** Override the label shown for the `ready` state (e.g. "waiting to export"). */
  readyLabel?: string;
}) {
  const { t } = useI18n();

  if (status === "queued") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <Clock className="size-3" />
        {t("status.queued")}
      </Badge>
    );
  }

  if (status === "error") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="destructive">
            <X className="size-3" />
            {t("status.failed")}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-wrap break-words">
          {error}
        </TooltipContent>
      </Tooltip>
    );
  }

  const isLoading = status === "converting" || status === "analyzing";
  const tokenClass = STATUS_TOKEN_MAP[status];

  return (
    <Badge className={cn(tokenClass)}>
      {isLoading && <Loader2 className="size-3 animate-spin" />}
      {!isLoading && <Check className="size-3" />}
      {status === "converting"
        ? t("status.converting")
        : status === "analyzing"
          ? t("status.analyzing")
          : status === "done"
            ? t("status.done")
            : (readyLabel ?? t("status.ready"))}
    </Badge>
  );
}

export { StatusBadge };
export type { Status as StatusBadgeStatus };
