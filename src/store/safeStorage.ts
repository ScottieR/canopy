import type { StateStorage } from "zustand/middleware";

type StorageErrorHandler = (name: string, error: unknown) => void;

const defaultStorageErrorHandler: StorageErrorHandler = (name, error) => {
  const errorName = error instanceof Error ? error.name : "StorageError";
  // Never log the serialized value: persisted state can contain user content.
  console.warn(`[storage] Skipped local persistence for ${name}: ${errorName}`);
};

/**
 * Wrap string storage so browser quota/security failures cannot escape through
 * Zustand's synchronous setState path and crash the React tree.
 */
export function createQuotaSafeStateStorage(
  storage: StateStorage,
  onError: StorageErrorHandler = defaultStorageErrorHandler,
): StateStorage {
  return {
    getItem(name) {
      try {
        return storage.getItem(name);
      } catch (error) {
        onError(name, error);
        return null;
      }
    },
    setItem(name, value) {
      try {
        return storage.setItem(name, value);
      } catch (error) {
        onError(name, error);
        return undefined;
      }
    },
    removeItem(name) {
      try {
        return storage.removeItem(name);
      } catch (error) {
        onError(name, error);
        return undefined;
      }
    },
  };
}

export const getQuotaSafeLocalStorage = (): StateStorage =>
  createQuotaSafeStateStorage(window.localStorage);
