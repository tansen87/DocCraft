/**
 * Format an elapsed duration for display: `ms` below one second, then
 * seconds, minutes and hours as the magnitude grows.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded}ms`;
  const totalSeconds = rounded / 1000;
  if (totalSeconds < 60) {
    const s = totalSeconds.toFixed(2).replace(/\.?0+$/, "");
    return `${s}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (totalMinutes < 60) return `${totalMinutes}min ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}min`;
}
