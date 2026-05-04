import re

with open('src/pages/ArchitectView/ConnectionsTab.tsx', 'r') as f:
    content = f.read()

# Add a listener for companion-finished
listener_code = """
  // ── Companion listener ──
  useEffect(() => {
    let unlisten: any;
    (async () => {
      try {
        const { listen: tauriListen } = await import('@tauri-apps/api/event');
        const listen = (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) ? tauriListen : async () => () => {};
        unlisten = await listen('companion-finished', async (e: any) => {
          const { type } = e.payload || {};
          if (type) {
            checkDynamicStatuses();
            if (type === "slack") {
              setSlackEnabled(true);
              toggleIntegration("slack", true);
              setGlobalConnections(prev => ({ ...prev, slack: true }));
            } else {
              setDynamicEnabled(prev => ({ ...prev, [type]: true }));
              toggleIntegration(type, true);
            }
          }
        });
      } catch (e) {}
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [agent.id]);
"""

# Insert right before checkDynamicStatuses definition
content = content.replace("  const checkDynamicStatuses = async () => {", listener_code + "\n  const checkDynamicStatuses = async () => {")

with open('src/pages/ArchitectView/ConnectionsTab.tsx', 'w') as f:
    f.write(content)

print("Added listener to ConnectionsTab")
