import '@testing-library/jest-dom';

// Mock Tauri API
global.mockTauriInvoke = async (command: string, payload?: any) => {
  console.log(`[Mock] Tauri command: ${command}`, payload);
  return null;
};

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock });
