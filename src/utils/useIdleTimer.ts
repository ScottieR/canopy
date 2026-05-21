import { useEffect, useRef } from "react";

export function useIdleTimer(timeoutMinutes: number, onIdle: () => void, isEnabled: boolean) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isEnabled) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      return;
    }

    const resetTimer = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(onIdle, timeoutMinutes * 60 * 1000);
    };

    // Initialize
    resetTimer();

    // Events that reset the idle timer
    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"];
    
    // We add true for capture phase to catch events even if propagation is stopped
    events.forEach((event) => {
      window.addEventListener(event, resetTimer, true);
    });

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      events.forEach((event) => {
        window.removeEventListener(event, resetTimer, true);
      });
    };
  }, [timeoutMinutes, onIdle, isEnabled]);
}
