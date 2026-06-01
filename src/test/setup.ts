import "@testing-library/jest-dom";
import { vi } from "vitest";

// Mock Tauri invoke — tests that exercise frontend logic should not call Rust
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
