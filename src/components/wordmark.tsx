import type React from "react";

import { cn } from "@/lib/utils";

/**
 * Product wordmark. One spec for every title bar that carries it (main window
 * and the snip result popup): 13px / 600, foreground ink, no tracking tricks.
 *
 * Props are forwarded so a caller can add `data-tauri-drag-region` - Tauri only
 * starts a window drag when the event target itself carries the attribute.
 */
export function Wordmark({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "select-none pt-px text-[13px] font-semibold leading-none tracking-[-0.006em] text-foreground",
        className,
      )}
      {...props}
    >
      DocCraft
    </span>
  );
}
