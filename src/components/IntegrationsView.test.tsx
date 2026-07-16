import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

const mockInvoke = vi.fn(async (command: string) => {
  if (command === "get_connectors_config") return [];
  if (command === "check_full_disk_access") return false;
  if (command === "get_secret_cmd") return "";
  if (command === "list_slack_channels") return [];
  return [];
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => (mockInvoke as any)(...args),
}));

vi.mock("./ProvidersVault", () => ({
  ProvidersVault: () => <div>Providers Vault</div>,
}));

vi.mock("./WebVault", () => ({
  WebVault: () => <div>Web Vault</div>,
}));

import { IntegrationsView } from "./IntegrationsView";

describe("IntegrationsView", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("treats agent-owned connectors as per-agent connections from the global page", async () => {
    render(<IntegrationsView agents={[]} />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("get_connectors_config");
      expect(mockInvoke).toHaveBeenCalledWith("check_full_disk_access");
    });

    expect(
      screen.getByText("Connect a Telegram bot from the specific agent that should own it.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Connect a Discord bot from the specific agent that should own it.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Connect GitHub from the specific agent that should own the token and repo bindings.")
    ).toBeInTheDocument();
    const telegramCard = screen.getByText("Telegram").closest("div");
    const discordCard = screen.getByText("Discord").closest("div");
    const githubCard = screen.getByText("GitHub").closest("div");

    expect(telegramCard).toBeTruthy();
    expect(discordCard).toBeTruthy();
    expect(githubCard).toBeTruthy();

    expect(within(telegramCard as HTMLElement).queryByRole("button", { name: "Connect" })).toBeNull();
    expect(within(discordCard as HTMLElement).queryByRole("button", { name: "Connect" })).toBeNull();
    expect(within(githubCard as HTMLElement).queryByRole("button", { name: "Connect" })).toBeNull();
  });
});
