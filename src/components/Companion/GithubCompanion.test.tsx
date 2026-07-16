import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockInvoke,
  mockOpen,
  mockEmit,
  mockClose,
  mockSetFocus,
  mockGetAllWindows,
} = vi.hoisted(() => {
  const mockSetFocus = vi.fn();
  return {
    mockInvoke: vi.fn(),
    mockOpen: vi.fn(),
    mockEmit: vi.fn(),
    mockClose: vi.fn(),
    mockSetFocus,
    mockGetAllWindows: vi.fn(async () => [{ label: "main", setFocus: mockSetFocus }]),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: mockOpen,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mockEmit,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getAllWindows: mockGetAllWindows,
  getCurrentWindow: () => ({
    close: mockClose,
    startDragging: vi.fn(),
  }),
}));

import { GithubCompanion } from "./GithubCompanion";

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("GithubCompanion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpen.mockResolvedValue(undefined);
    mockEmit.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockSetFocus.mockResolvedValue(undefined);
    mockInvoke.mockImplementation(async (command: string, payload?: any) => {
      if (command === "store_secret_cmd") return null;
      if (command === "fetch_github_repos") {
        return [
          { id: 1, name: "repo-one", full_name: "acme/repo-one", private: false },
          { id: 2, name: "repo-two", full_name: "acme/repo-two", private: true },
        ];
      }
      if (command === "update_agent_integrations") return null;
      throw new Error(`Unexpected invoke: ${command} ${JSON.stringify(payload)}`);
    });
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("stages a GitHub token for onboarding instead of configuring the live agent immediately", async () => {
    window.history.replaceState({}, "", "/index.html?companion=github&agentId=agent-test&isNew=true");

    render(<GithubCompanion />);
    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalledWith("https://github.com/settings/tokens/new");
    });

    fireEvent.change(screen.getByPlaceholderText("ghp_..."), {
      target: { value: "ghp_test_token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify Token" }));
    await flushAsyncWork();

    expect(mockInvoke).toHaveBeenCalledWith("store_secret_cmd", {
      key: "github-access-token-agent-test",
      value: "ghp_test_token",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "configure_github",
      expect.anything()
    );
    await waitFor(() => {
      expect(screen.getByText("Step 3: Verify Access")).toBeInTheDocument();
      expect(screen.getByText("acme/repo-one")).toBeInTheDocument();
    });
  }, 10000);

  it("emits the onboarding completion payload with the selected repositories", async () => {
    window.history.replaceState({}, "", "/index.html?companion=github&agentId=agent-test&isNew=true");

    render(<GithubCompanion />);
    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalledWith("https://github.com/settings/tokens/new");
    });

    fireEvent.change(screen.getByPlaceholderText("ghp_..."), {
      target: { value: "ghp_test_token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify Token" }));
    await flushAsyncWork();

    await waitFor(() => {
      expect(screen.getByText("acme/repo-one")).toBeInTheDocument();
    });
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Complete Setup" }));
    });
    await flushAsyncWork();

    expect(mockEmit).toHaveBeenCalledWith("companion-finished", {
      type: "github",
      token: "ghp_test_token",
      selectedRepos: ["acme/repo-one"],
    });

    await waitFor(() => {
      expect(mockSetFocus).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    }, { timeout: 4000 });
  }, 10000);
});
