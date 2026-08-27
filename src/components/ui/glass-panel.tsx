import * as React from "react";

import { cn } from "@/lib/utils";
import { useGlassOpacity } from "@/lib/glass-opacity";

function GlassPanel({
  className,
  hover,
  blur = true,
  ...props
}: React.ComponentProps<"div"> & {
  hover?: boolean;
  blur?: boolean;
}) {
  const opacity = useGlassOpacity();

  return (
    <div
      data-slot="glass-panel"
      className={cn(
        "glass-panel",
        blur && "glass-blur",
        hover && "glass-hover",
        className,
      )}
      style={{ "--glass-bg-opacity": opacity / 100 } as React.CSSProperties}
      {...props}
    />
  );
}

export { GlassPanel };
