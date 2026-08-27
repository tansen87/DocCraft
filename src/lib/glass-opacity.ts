import { createContext, useContext } from "react";

/** Current main-window glass opacity (0–100). Consumed by GlassPanel. */
export const GlassOpacityContext = createContext(100);

export function useGlassOpacity(): number {
  return useContext(GlassOpacityContext);
}
