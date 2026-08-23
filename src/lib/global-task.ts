import { useSyncExternalStore } from "react";
import type { WorkspaceTab } from "@/components/layout/app-header";

/**
 * Lightweight external store so every workspace view can report what it is
 * currently doing; the app header renders one pill per running task and lets
 * the user jump straight back to that tab.
 */
export type GlobalTasks = ReadonlyMap<WorkspaceTab, string>;

let tasks: GlobalTasks = new Map();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Report a view's running status (`text`) or clear it (`null`). */
export function setViewTask(tab: WorkspaceTab, text: string | null): void {
  if (tasks.get(tab) === text) return;
  const next = new Map(tasks);
  if (text === null) {
    next.delete(tab);
  } else {
    next.set(tab, text);
  }
  tasks = next;
  emit();
}

export function useGlobalTasks(): GlobalTasks {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => tasks,
  );
}
