import React, { useState, useEffect } from "react";

export interface GenerativeResult {
  versionId: string;
  userPrompt: string;
  injectedPrompt: string;
  compiledImageUrl: string;
  meshyManifest: {
    base: string;
    accessories: string[];
    habitat?: string;
  };
}

export function GenerativeStudio({ defaultRole, onApply }: { defaultRole?: string, onApply: (res: GenerativeResult) => void }) {
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [history, setHistory] = useState<GenerativeResult[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);

  const activeResult = currentIndex >= 0 ? history[currentIndex] : null;

  // The secret sauce: intercepting the user's prompt and enforcing brand identity
  const buildInjectedPrompt = (userText: string) => {
    return `Isometric 3D-rendered lobster character in Monument Valley art style. Rounded bell-shaped body with smooth round head and swept-back antennae. Flat-shaded low-poly faces, soft directional lighting from upper-left. Warm muted pastel palette. No outlines. ${userText}`;
  };

  const parseMockManifest = (userText: string) => {
    // Very naive mock parser just to simulate the API splitting output
    const text = userText.toLowerCase();
    const isHabitat = text.includes("habitat") || text.includes("world") || text.includes("background");
    
    return {
      base: isHabitat ? "none (habitat only)" : `Standard lobster profile derived from: "${userText.substring(0, 20)}..."`,
      accessories: text.includes("hat") ? ["/models/tophat.glb"] : text.includes("glasses") ? ["/models/glasses.glb"] : [],
      habitat: isHabitat ? "Custom Environment" : undefined
    };
  };

  const handleGenerate = () => {
    if (!prompt.trim() || isGenerating) return;
    
    setIsGenerating(true);
    const injected = buildInjectedPrompt(prompt);
    const manifest = parseMockManifest(prompt);
    
    // Simulate API delay (Nano Banana Pro / BFL)
    setTimeout(() => {
      const newResult: GenerativeResult = {
        versionId: `v${history.length + 1}`,
        userPrompt: prompt,
        injectedPrompt: injected,
        compiledImageUrl: `https://placehold.co/600x400/218380/FFFFFF?text=Generated+Concept:+${encodeURIComponent(prompt.substring(0, 15))}`,
        meshyManifest: manifest
      };
      
      const newHistory = [...history.slice(0, currentIndex + 1), newResult];
      setHistory(newHistory);
      setCurrentIndex(newHistory.length - 1);
      setPrompt("");
      setIsGenerating(false);
    }, 2500); // Mock 2.5s generation time
  };

  const handleRevert = (dir: -1 | 1) => {
    const newIndex = currentIndex + dir;
    if (newIndex >= 0 && newIndex < history.length) {
      setCurrentIndex(newIndex);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 16 }}>
      
      {/* ── Visual Output ── */}
      <div style={{ flex: 1, background: "rgba(255,255,255,0.4)", borderRadius: 24, border: "1px solid rgba(0,0,0,0.06)", overflow: "hidden", display: "flex", flexDirection: "column", position: "relative" }}>
        
        {isGenerating ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 48, height: 48, border: "4px solid rgba(33,131,128,0.2)", borderTopColor: "#218380", borderRadius: "50%", animation: "spin 1s linear infinite", marginBottom: 16 }} />
            <div style={{ fontSize: 16, fontWeight: 700, color: "#218380" }}>Nano Banana Pro is thinking...</div>
            <div style={{ fontSize: 12, color: "#636E72", marginTop: 8, fontStyle: "italic", maxWidth: "80%", textAlign: "center" }}>Applying Monument Valley heuristics to "{prompt}"...</div>
          </div>
        ) : activeResult ? (
          <div style={{ display: "flex", height: "100%" }}>
            {/* Left: Render */}
            <div style={{ flex: 2, position: "relative", borderRight: "1px solid rgba(0,0,0,0.06)" }}>
              <img src={activeResult.compiledImageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="Generated" />
              <div style={{ position: "absolute", top: 16, left: 16, background: "rgba(0,0,0,0.6)", color: "white", padding: "4px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600 }}>
                Version {activeResult.versionId}
              </div>
            </div>
            
            {/* Right: Meshy Manifest */}
            <div style={{ flex: 1, padding: 20, overflow: "auto", background: "rgba(255,255,255,0.6)" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#303330", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.05em" }}>Meshy Payload</div>
              <div style={{ fontSize: 11, color: "#636E72", marginBottom: 12 }}>This structural manifest is isolated and sent to the 3D generation API.</div>
              
              <div style={{ background: "#2D3436", color: "#A8B2B7", padding: 16, borderRadius: 12, fontSize: 11, fontFamily: "monospace", overflowX: "auto" }}>
                <div style={{ color: "#218380", marginBottom: 8 }}>// Base Geometry</div>
                <div>"base": "{activeResult.meshyManifest.base}"</div>
                
                <div style={{ color: "#218380", marginTop: 16, marginBottom: 8 }}>// Isolated Accessories</div>
                <div>"accessories": {JSON.stringify(activeResult.meshyManifest.accessories)}</div>
                
                {activeResult.meshyManifest.habitat && (
                  <>
                    <div style={{ color: "#218380", marginTop: 16, marginBottom: 8 }}>// Habitat Config</div>
                    <div>"habitat": "{activeResult.meshyManifest.habitat}"</div>
                  </>
                )}
              </div>

              <button onClick={() => onApply(activeResult)} style={{
                marginTop: 24, width: "100%", padding: "12px", borderRadius: 12, border: "none",
                background: "linear-gradient(135deg, #218380, #4A9E96)", color: "white",
                fontSize: 14, fontWeight: 700, cursor: "pointer", boxShadow: "0 8px 24px rgba(33,131,128,0.25)",
              }}>
                Keep & Assign to Agent
              </button>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🎨</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#303330", marginBottom: 8 }}>Nano Banana Pro Studio</div>
            <div style={{ fontSize: 14, color: "#636E72", maxWidth: 400, lineHeight: 1.5 }}>
              Describe a personality, role, or accessory. The generator will securely enforce The Canopy's styling and automatically split your 2D concept into a 3D semantic layout.
            </div>
          </div>
        )}
      </div>

      {/* ── Input Controls ── */}
      <div>
        <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
            placeholder={activeResult ? 'Tweak this (e.g. "remove the hat", "make it neon")' : "e.g. A wizard lobster reading a spellbook"}
            disabled={isGenerating}
            style={{ 
              flex: 1, padding: "16px 20px", borderRadius: 16, border: "1px solid rgba(0,0,0,0.08)", 
              background: "rgba(255,255,255,0.7)", fontSize: 15, outline: "none",
              boxShadow: "inset 0 2px 4px rgba(0,0,0,0.02)"
            }}
          />
          <button 
            onClick={handleGenerate} 
            disabled={isGenerating || !prompt.trim()}
            style={{ 
              padding: "16px 32px", borderRadius: 16, border: "none", 
              background: isGenerating || !prompt.trim() ? "rgba(0,0,0,0.05)" : "#303330", 
              color: isGenerating || !prompt.trim() ? "#A0A0A0" : "white", 
              fontSize: 15, fontWeight: 600, cursor: isGenerating || !prompt.trim() ? "not-allowed" : "pointer",
              transition: "all 0.2s"
            }}
          >
            {activeResult ? "Refine" : "Generate"}
          </button>
        </div>

        {/* History Reversion */}
        {history.length > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,255,255,0.4)", padding: "12px 16px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.04)" }}>
            <div style={{ fontSize: 12, color: "#636E72", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>History</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button 
                onClick={() => handleRevert(-1)} disabled={currentIndex <= 0}
                style={{ padding: "6px 12px", borderRadius: 8, border: "none", cursor: currentIndex <= 0 ? "not-allowed" : "pointer", background: currentIndex <= 0 ? "transparent" : "white", opacity: currentIndex <= 0 ? 0.3 : 1 }}
              >
                ← Prev V{currentIndex > 0 ? currentIndex : ""}
              </button>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#303330", minWidth: 60, textAlign: "center" }}>V{currentIndex + 1} of {history.length}</div>
              <button 
                onClick={() => handleRevert(1)} disabled={currentIndex >= history.length - 1}
                style={{ padding: "6px 12px", borderRadius: 8, border: "none", cursor: currentIndex >= history.length - 1 ? "not-allowed" : "pointer", background: currentIndex >= history.length - 1 ? "transparent" : "white", opacity: currentIndex >= history.length - 1 ? 0.3 : 1 }}
              >
                Next V{currentIndex + 2 > history.length ? "" : currentIndex + 2} →
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
