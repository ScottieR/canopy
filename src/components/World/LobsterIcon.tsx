import React from "react";

// ─── LobsterIcon ─────────────────────────────────────────────────────────────
//
// Intentionally zero project-level dependencies — only React.
// Avoids any risk of circular imports or transitive module-load failures
// when this component is used deep in the module graph.

// Inline image map (mirrors shared/agents.json `image` fields)
const ROLE_IMAGES: Record<string, string> = {
  "Coder":              "/agents/Coder.png",
  "Kids Coordinator":   "/agents/KidsCoordinator.png",
  "Accountant":         "/agents/Accountant.png",
  "Researcher":         "/agents/Researcher.png",
  "Marketing Guru":     "/agents/MarketingGuru.png",
  "Custom":             "/agents/Custom.png",
  "Tutor":              "/agents/Tutor.png",
  "Interior Designer":  "/agents/InteriorDesigner.png",
  "Fashion Stylist":    "/agents/FashionStylist.png",
  "Therapist":          "/agents/Therapist.png",
  "Chef":               "/agents/Chef1.png",
  "Travel Agent":       "/agents/TravelAgent.png",
  "Media Advisor":      "/agents/MediaAdvisor.png",
  "Relationship Guru":  "/agents/RelationshipGuru.png",
  "Business Strategist":"/agents/BusinessStrategist.png",
  "Educator":           "/agents/Educator.png",
  "Artist":             "/agents/Artist.png",
  "Architect":          "/agents/Architect.png",
  "Musician":           "/agents/Musician.png",
  "Investment Manager": "/agents/InvestmentManager.png",
  "Trainer":            "/agents/Trainer.png",
};

function resolveImageUrl(path: string): string {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("data:")) return path;
  if (path.startsWith("/accessories") || path.startsWith("/models") || path.startsWith("/agents")) {
    const base = (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_API_URL) || "http://localhost:3001";
    return `${base}${path}`;
  }
  return path;
}

export function LobsterIcon({
  size = 48, className = "", role, agentImage,
  reactState = "off",
}: {
  size?: number; shellColor?: string; accentColor?: string;
  className?: string; role?: string; agentImage?: string | null;
  reactState?: "off" | "idle" | "thinking" | "error" | "happy";
}) {
  const fallback = role ? (ROLE_IMAGES[role] ?? "/agents/Custom.png") : "/agents/Custom.png";
  const imageSrc = agentImage || fallback;

  const animation =
    reactState === "idle"     ? "lobster-breathe 4.2s ease-in-out infinite" :
    reactState === "thinking" ? "lobster-think 1.6s ease-in-out infinite"   :
    reactState === "error"    ? "lobster-error 0.4s ease-out forwards"      :
    reactState === "happy"    ? "lobster-happy 0.6s ease-out"               :
    "none";

  const filter =
    reactState === "thinking" ? "brightness(1.08) saturate(1.05)" :
    reactState === "error"    ? "saturate(0.6) brightness(0.92)"  :
    undefined;

  return (
    <img
      src={resolveImageUrl(imageSrc)}
      alt="Lobster Agent"
      style={{
        width: size, height: size, objectFit: "cover", borderRadius: "50%",
        animation, filter,
        transformOrigin: "center 70%",
        transition: "filter 0.3s ease",
      }}
      className={className}
    />
  );
}
