import { recordUsage as record } from "@/lib/ipc";
import type { OcrMode, UsageInput } from "@/lib/types";

/** Today's local date as `YYYY-MM-DD` - the usage log's day bucket. */
export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Map an OCR mode to the engine badge stored in the usage log (`null` = no OCR). */
export function engineForMode(mode: OcrMode | string): "local" | "ai" | null {
  if (mode === "forceLocal" || mode === "nonTextLocal") return "local";
  if (mode === "forceAi" || mode === "nonTextAi") return "ai";
  return null;
}

/**
 * Record one usage event on the local JSONL log. The date is attached here;
 * failures are swallowed so statistics can never break the conversion flow.
 */
export function recordUsage(input: Omit<UsageInput, "date">) {
  void record({ ...input, date: localDate() }).catch(() => undefined);
}
