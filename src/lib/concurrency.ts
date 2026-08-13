import { getAppSettings } from "@/lib/ipc";

export const DEFAULT_MAX_CONCURRENT = 1;
export const MAX_CONCURRENT_LIMIT = 16;

let cached = DEFAULT_MAX_CONCURRENT;
let loading: Promise<number> | null = null;

function clampConcurrent(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONCURRENT;
  return Math.min(MAX_CONCURRENT_LIMIT, Math.max(1, Math.round(n)));
}

/** Read the persisted concurrency once; concurrent callers share the promise. */
export function ensureMaxConcurrent(): Promise<number> {
  if (!loading) {
    loading = getAppSettings()
      .then((s) => {
        cached = clampConcurrent(s.maxConcurrent);
        return cached;
      })
      .catch(() => {
        cached = DEFAULT_MAX_CONCURRENT;
        return cached;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

export function getMaxConcurrent(): number {
  return cached;
}

/** Update the in-memory value after the user changes it in settings. */
export function setMaxConcurrent(n: number): void {
  cached = clampConcurrent(n);
}
