export function HandoffIndicator() {
  // TODO: Wire to real data flows from backend
  return (
    <div
      className="rounded-xl p-3.5 flex items-center gap-3"
      style={{
        background: "rgba(167,139,250,0.04)",
        border: "1px solid rgba(167,139,250,0.12)",
      }}
    >
      <p className="text-[12px] text-canopy-text-muted/60">
        No active data flows yet. Set up standing flows between agents to see them here.
      </p>
    </div>
  );
}
