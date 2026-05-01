import { vi } from 'vitest';
import '@testing-library/jest-dom';

// Mock Tauri API
(globalThis as any).mockTauriInvoke = vi.fn(async (command: string, payload?: any) => {
  console.log(`[Mock] Tauri command: ${command}`, payload);
  return null;
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => (globalThis as any).mockTauriInvoke(...args),
}));

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock });
