import { useEffect, useState } from "react";
import { FlavorInfo, getCachedFlavor, getFlavor } from "../utils/flavor";

/** React access to the active prod/dev flavor (null while loading). */
export function useFlavor(): FlavorInfo | null {
  const [flavor, setFlavor] = useState<FlavorInfo | null>(getCachedFlavor());

  useEffect(() => {
    if (flavor) return;
    let cancelled = false;
    getFlavor().then(f => {
      if (!cancelled) setFlavor(f);
    });
    return () => {
      cancelled = true;
    };
  }, [flavor]);

  return flavor;
}
