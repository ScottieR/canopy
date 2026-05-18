import React, { useState, useEffect, useRef, useCallback } from "react";
import { ForumAgent } from "../../store/forumStore";
import { getAssetUrl } from "../../utils/assets";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number;
  size: number;
  color: string;
}

interface AgentSprite {
  agent: ForumAgent;
  x: number; y: number;
  targetX: number; targetY: number;
  bobOffset: number;    // phase offset for CSS bob animation
  glowPulse: number;    // phase offset for canvas glow pulse
}

// Minimal position record — just geometry, used for HTML img placement
interface SpritePos {
  agentId: string;
  x: number;
  y: number;
  bobOffset: number;
}

interface Props {
  agents: ForumAgent[];
  height?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const bigint = parseInt(
    clean.length === 3 ? clean.split("").map(c => c + c).join("") : clean, 16
  );
  return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function quadBezier(t: number, p0: number, p1: number, p2: number): number {
  return (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2;
}

// ─── Agent position layout ────────────────────────────────────────────────────

function layoutAgents(agents: ForumAgent[], w: number, h: number): AgentSprite[] {
  const n = agents.length;
  if (n === 0) return [];

  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.28;

  return agents.map((agent, i) => {
    const angle = n === 1
      ? -Math.PI / 2
      : -Math.PI / 2 + ((i / (n - 1)) - 0.5) * Math.PI * 1.2;
    const r = n === 1 ? 0 : radius;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    return {
      agent, x, y, targetX: x, targetY: y,
      bobOffset: (i / n) * Math.PI * 2,
      glowPulse: (i / n) * Math.PI * 2 + 0.5,
    };
  });
}

// ─── Canvas-only drawing helpers ──────────────────────────────────────────────

function drawGlow(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number,
  color: string, t: number, phase: number
) {
  const pulse = 0.65 + 0.35 * Math.sin(t * 1.2 + phase);
  const r = size * 0.95 * pulse;
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, rgba(color, 0.22 * pulse));
  grad.addColorStop(1, rgba(color, 0));
  ctx.save();
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawArc(
  ctx: CanvasRenderingContext2D,
  from: AgentSprite, to: AgentSprite, color: string
) {
  const mx = (from.x + to.x) / 2;
  const my = Math.min(from.y, to.y) - 40;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(mx, my, to.x, to.y);
  ctx.strokeStyle = rgba(color, 0.18);
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 6]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawArcParticle(
  ctx: CanvasRenderingContext2D,
  from: AgentSprite, to: AgentSprite, t: number, color: string
) {
  const mx = (from.x + to.x) / 2;
  const my = Math.min(from.y, to.y) - 40;
  const px = quadBezier(t, from.x, mx, to.x);
  const py = quadBezier(t, from.y, my, to.y);

  const grad = ctx.createRadialGradient(px, py, 0, px, py, 8);
  grad.addColorStop(0, rgba(color, 0.8));
  grad.addColorStop(1, rgba(color, 0));
  ctx.save();
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(px, py, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px, py, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fill();
  ctx.restore();
}

// ─── CSS keyframes (injected once) ───────────────────────────────────────────

let bobKeysInjected = false;
function injectBobKeyframes() {
  if (bobKeysInjected || typeof document === "undefined") return;
  if (document.getElementById("forum-stage-bob-keys")) {
    bobKeysInjected = true;
    return;
  }
  bobKeysInjected = true;
  const el = document.createElement("style");
  el.id = "forum-stage-bob-keys";
  el.textContent = `
    @keyframes forum-stage-bob {
      0%, 100% { transform: translate(-50%, -50%); }
      50%       { transform: translate(-50%, calc(-50% - 5px)); }
    }
  `;
  document.head.appendChild(el);
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ForumStage({ agents, height = 200 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const startTime = useRef(Date.now());
  const spritesRef = useRef<AgentSprite[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const arcProgressRef = useRef<number>(0);

  // SpritePos drives the HTML img overlays — only geometry, no agent refs
  const [positions, setPositions] = useState<SpritePos[]>([]);

  injectBobKeyframes();

  const spawnParticle = useCallback((x: number, y: number, color: string) => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.3 + Math.random() * 0.5;
    particlesRef.current.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 0.4,
      life: 1, size: 1.5 + Math.random() * 2, color,
    });
  }, []);

  // Recompute layout when canvas resizes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      const sprites = layoutAgents(agents, canvas.offsetWidth, canvas.offsetHeight);
      spritesRef.current = sprites;
      setPositions(sprites.map(s => ({
        agentId: s.agent.agentId,
        x: s.x, y: s.y,
        bobOffset: s.bobOffset,
      })));
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [agents]);

  // Also recompute when agents list identity changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sprites = layoutAgents(agents, canvas.offsetWidth, canvas.offsetHeight);
    spritesRef.current = sprites;
    setPositions(sprites.map(s => ({
      agentId: s.agent.agentId,
      x: s.x, y: s.y,
      bobOffset: s.bobOffset,
    })));
  }, [agents]);

  // Canvas animation loop — effects only (glow, arcs, particles)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let lastParticleTime = 0;

    const frame = () => {
      const now = Date.now();
      const t = (now - startTime.current) / 1000;
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;

      ctx.clearRect(0, 0, w, h);

      // Very subtle warm wash — blends with the light-cream app theme
      const bgGrad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      bgGrad.addColorStop(0, "rgba(60,102,99,0.06)");
      bgGrad.addColorStop(1, "rgba(60,102,99,0.02)");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      const sprites = spritesRef.current;

      // Connecting arcs between adjacent agents
      for (let i = 0; i < sprites.length - 1; i++) {
        drawArc(ctx, sprites[i], sprites[i + 1], sprites[i].agent.robeColor || "#4A9E96");
      }

      // Flowing handoff particle across arcs
      if (sprites.length >= 2) {
        arcProgressRef.current = (arcProgressRef.current + 0.004) % 1;
        const segIdx = Math.min(Math.floor(arcProgressRef.current * (sprites.length - 1)), sprites.length - 2);
        const from = sprites[segIdx];
        const to   = sprites[segIdx + 1];
        const localT = (arcProgressRef.current * (sprites.length - 1)) % 1;
        if (from && to) {
          drawArcParticle(ctx, from, to, localT, from.agent.robeColor || "#4A9E96");
        }
      }

      // Ambient spore particles
      if (now - lastParticleTime > 500 && sprites.length > 0) {
        const src = sprites[Math.floor(Math.random() * sprites.length)];
        spawnParticle(
          src.x + (Math.random() - 0.5) * 24,
          src.y + (Math.random() - 0.5) * 24,
          src.agent.robeColor || "#4A9E96"
        );
        lastParticleTime = now;
      }

      // Update + draw ambient particles
      particlesRef.current = particlesRef.current.filter(p => p.life > 0);
      for (const p of particlesRef.current) {
        p.x += p.vx; p.y += p.vy; p.life -= 0.008;
        ctx.save();
        ctx.globalAlpha = p.life * 0.35;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.restore();
      }

      // Glow halos behind each agent avatar
      for (const sprite of sprites) {
        drawGlow(ctx, sprite.x, sprite.y, 46, sprite.agent.robeColor || "#4A9E96", t, sprite.glowPulse);
      }

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [spawnParticle]);

  return (
    <div style={{ position: "relative", width: "100%", height, overflow: "hidden" }}>

      {/* Background canvas — animation effects only */}
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute", inset: 0,
          width: "100%", height: "100%",
          display: "block",
        }}
      />

      {/* Agent avatars — real 3D render images, CSS-bobbing over the canvas */}
      {positions.map(pos => {
        // Look up live agent data from props (includes currentAction updates)
        const agent = agents.find(a => a.agentId === pos.agentId);
        if (!agent) return null;

        const color = agent.robeColor || "#4A9E96";
        const imgSrc = getAssetUrl(agent.image || "");
        const action = agent.currentAction || agent.forumRole;
        // Negative animation-delay creates staggered phases from the same keyframe
        const bobDelay = `${-(pos.bobOffset / (Math.PI * 2)) * 4.2}s`;

        return (
          <div
            key={pos.agentId}
            style={{
              position: "absolute",
              left: pos.x,
              top: pos.y,
              // CSS bob animation — replaces the canvas drawLobster bob
              animation: "forum-stage-bob 4.2s ease-in-out infinite",
              animationDelay: bobDelay,
              // Center the element on the computed position
              transform: "translate(-50%, -50%)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              pointerEvents: "none",
            }}
          >
            {/* Avatar: initials circle as base, real image overlaid */}
            <div style={{ position: "relative", width: 48, height: 48 }}>
              {/* Initials fallback (always present, hidden by img if img loads) */}
              <div style={{
                width: 48, height: 48, borderRadius: "50%",
                background: rgba(color, 0.18),
                border: `2px solid ${color}88`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 15, fontWeight: 700, color,
              }}>
                {agent.name.charAt(0).toUpperCase()}
              </div>

              {/* Real image — covers initials when loaded */}
              {imgSrc && (
                <img
                  src={imgSrc}
                  alt={agent.name}
                  style={{
                    position: "absolute", inset: 0,
                    width: 48, height: 48,
                    borderRadius: "50%",
                    objectFit: "cover",
                    border: `2px solid ${color}88`,
                    boxShadow: `0 2px 12px ${rgba(color, 0.3)}`,
                  }}
                  onError={e => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              )}
            </div>

            {/* Agent name */}
            <div style={{
              fontSize: 10, fontWeight: 600,
              color: "var(--text-main, #303330)",
              maxWidth: 72,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              textAlign: "center",
              // Light backdrop so name is legible over canvas wash
              textShadow: "0 1px 4px rgba(250,249,246,0.9), 0 0 8px rgba(250,249,246,0.8)",
            }}>
              {agent.name}
            </div>

            {/* Live status / forum role */}
            <div style={{
              fontSize: 9,
              color,
              opacity: 0.75,
              maxWidth: 82,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              textAlign: "center",
              textShadow: "0 1px 3px rgba(250,249,246,0.9)",
            }}>
              {action.length > 22 ? action.slice(0, 22) + "…" : action}
            </div>
          </div>
        );
      })}
    </div>
  );
}
