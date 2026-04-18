/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        canopy: {
          bg: "#0A0F0D",
          surface: "#0F1A15",
          "surface-hover": "#172B22",
          "surface-raised": "#1E3A2E",
          accent: "#34D399",
          "accent-bright": "#6EE7B7",
          text: "#F0FDF4",
          "text-muted": "#86EFAC",
          "text-dim": "#4ADE80",
          border: "#1E3A2E",
          active: "#4ADE80",
          sleeping: "#6B7280",
          thinking: "#34D399",
          warning: "#FCD34D",
          danger: "#FCA5A5",
          isolated: "#A78BFA",
        },
      },
      fontFamily: {
        sans: ["DM Sans", "system-ui", "-apple-system", "sans-serif"],
        heading: ["Satoshi", "DM Sans", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      animation: {
        breathe: "breathe 4s ease-in-out infinite",
        pulse: "pulse 3s ease-in-out infinite",
        "glow-pulse": "glowPulse 2s ease-in-out infinite",
        "flow-dash": "flowDash 2s linear infinite",
        "float-up": "floatUp 5s ease-in-out infinite",
        "fade-slide-up": "fadeSlideUp 0.4s ease-out both",
      },
      keyframes: {
        breathe: {
          "0%, 100%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.004)" },
        },
        glowPulse: {
          "0%, 100%": { boxShadow: "0 0 8px rgba(52,211,153,0.15)" },
          "50%": { boxShadow: "0 0 20px rgba(52,211,153,0.3)" },
        },
        flowDash: {
          to: { strokeDashoffset: "-20" },
        },
        floatUp: {
          "0%": { transform: "translateY(0) scale(1)", opacity: "0.15" },
          "50%": { opacity: "0.25" },
          "100%": { transform: "translateY(-30px) scale(0.5)", opacity: "0" },
        },
        fadeSlideUp: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
