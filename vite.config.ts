import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [".."] },
    watch: {
      // Don't trigger reloads on agent worktrees or Rust build output —
      // both churn constantly during tauri dev and cause spurious full reloads.
      ignored: ["**/.claude/**", "**/src-tauri/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  test: {
    globals: true,
    environment: "jsdom",
    exclude: ["node_modules", "dist", ".idea", ".git", ".cache", ".claude/**"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
