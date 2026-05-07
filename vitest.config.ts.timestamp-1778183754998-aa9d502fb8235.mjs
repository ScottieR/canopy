// vitest.config.ts
import { defineConfig } from "file:///sessions/modest-peaceful-pascal/mnt/Agent%20Management/canopy/node_modules/vitest/dist/config.js";
import react from "file:///sessions/modest-peaceful-pascal/mnt/Agent%20Management/canopy/node_modules/@vitejs/plugin-react/dist/index.js";
import path from "path";
var __vite_injected_original_dirname = "/sessions/modest-peaceful-pascal/mnt/Agent Management/canopy";
var vitest_config_default = defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/tests/setup.ts"],
    exclude: ["node_modules", "dist", "e2e/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/", "e2e/"]
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__vite_injected_original_dirname, "./src")
    }
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9zZXNzaW9ucy9tb2Rlc3QtcGVhY2VmdWwtcGFzY2FsL21udC9BZ2VudCBNYW5hZ2VtZW50L2Nhbm9weVwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL3Nlc3Npb25zL21vZGVzdC1wZWFjZWZ1bC1wYXNjYWwvbW50L0FnZW50IE1hbmFnZW1lbnQvY2Fub3B5L3ZpdGVzdC5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL3Nlc3Npb25zL21vZGVzdC1wZWFjZWZ1bC1wYXNjYWwvbW50L0FnZW50JTIwTWFuYWdlbWVudC9jYW5vcHkvdml0ZXN0LmNvbmZpZy50c1wiO2ltcG9ydCB7IGRlZmluZUNvbmZpZyB9IGZyb20gJ3ZpdGVzdC9jb25maWcnO1xuaW1wb3J0IHJlYWN0IGZyb20gJ0B2aXRlanMvcGx1Z2luLXJlYWN0JztcbmltcG9ydCBwYXRoIGZyb20gJ3BhdGgnO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBwbHVnaW5zOiBbcmVhY3QoKV0sXG4gIHRlc3Q6IHtcbiAgICBnbG9iYWxzOiB0cnVlLFxuICAgIGVudmlyb25tZW50OiAnanNkb20nLFxuICAgIHNldHVwRmlsZXM6IFsnLi9zcmMvdGVzdHMvc2V0dXAudHMnXSxcbiAgICBleGNsdWRlOiBbJ25vZGVfbW9kdWxlcycsICdkaXN0JywgJ2UyZS8qKi8qLnNwZWMudHMnXSxcbiAgICBjb3ZlcmFnZToge1xuICAgICAgcHJvdmlkZXI6ICd2OCcsXG4gICAgICByZXBvcnRlcjogWyd0ZXh0JywgJ2pzb24nLCAnaHRtbCddLFxuICAgICAgZXhjbHVkZTogWydub2RlX21vZHVsZXMvJywgJ2Rpc3QvJywgJ2UyZS8nXSxcbiAgICB9LFxuICB9LFxuICByZXNvbHZlOiB7XG4gICAgYWxpYXM6IHtcbiAgICAgICdAJzogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJy4vc3JjJyksXG4gICAgfSxcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUE0VyxTQUFTLG9CQUFvQjtBQUN6WSxPQUFPLFdBQVc7QUFDbEIsT0FBTyxVQUFVO0FBRmpCLElBQU0sbUNBQW1DO0FBSXpDLElBQU8sd0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVMsQ0FBQyxNQUFNLENBQUM7QUFBQSxFQUNqQixNQUFNO0FBQUEsSUFDSixTQUFTO0FBQUEsSUFDVCxhQUFhO0FBQUEsSUFDYixZQUFZLENBQUMsc0JBQXNCO0FBQUEsSUFDbkMsU0FBUyxDQUFDLGdCQUFnQixRQUFRLGtCQUFrQjtBQUFBLElBQ3BELFVBQVU7QUFBQSxNQUNSLFVBQVU7QUFBQSxNQUNWLFVBQVUsQ0FBQyxRQUFRLFFBQVEsTUFBTTtBQUFBLE1BQ2pDLFNBQVMsQ0FBQyxpQkFBaUIsU0FBUyxNQUFNO0FBQUEsSUFDNUM7QUFBQSxFQUNGO0FBQUEsRUFDQSxTQUFTO0FBQUEsSUFDUCxPQUFPO0FBQUEsTUFDTCxLQUFLLEtBQUssUUFBUSxrQ0FBVyxPQUFPO0FBQUEsSUFDdEM7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
