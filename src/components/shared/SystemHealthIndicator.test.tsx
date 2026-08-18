import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("lucide-react", () => ({
    AlertTriangle: () => null,
    ChevronDown: () => null,
    ChevronUp: () => null,
    X: () => null,
}));

// Capture the system-health-changed handler so tests can push snapshots the
// same way the Rust registry does.
let healthHandler: ((event: { payload: any }) => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async (name: string, handler: (event: { payload: any }) => void) => {
        if (name === "system-health-changed") healthHandler = handler;
        return () => {};
    }),
}));

describe("SystemHealthIndicator", () => {
    beforeEach(() => {
        healthHandler = undefined;
        (globalThis as any).mockTauriInvoke = vi.fn(async (command: string) => {
            if (command === "get_system_health") return [];
            return null;
        });
    });

    it("renders nothing while every component is ok", async () => {
        const { SystemHealthIndicator } = await import("./SystemHealthIndicator");
        const { container } = render(<SystemHealthIndicator />);

        await act(async () => {
            healthHandler?.({
                payload: [
                    { component: "jit_server", status: "ok" },
                    { component: "dispatch", status: "ok" },
                ],
            });
        });

        expect(container).toBeEmptyDOMElement();
    });

    it("shows a pill for a failed component, expandable to reason and remediation", async () => {
        const { SystemHealthIndicator } = await import("./SystemHealthIndicator");
        render(<SystemHealthIndicator />);

        await act(async () => {
            healthHandler?.({
                payload: [
                    { component: "dispatch", status: "ok" },
                    {
                        component: "jit_server",
                        status: "failed",
                        reason: "Agent authorization server couldn't start: port 18802 is unavailable",
                        remediation: "Is another copy of Canopy running? Quit it and relaunch.",
                    },
                ],
            });
        });

        const pill = screen.getByRole("button", { name: "1 system issue detected" });
        fireEvent.click(pill);

        expect(screen.getByText("Agent authorization server")).toBeInTheDocument();
        expect(
            screen.getByText(
                "Agent authorization server couldn't start: port 18802 is unavailable",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Is another copy of Canopy running? Quit it and relaunch."),
        ).toBeInTheDocument();
        // The healthy component stays out of the problem list.
        expect(screen.queryByText("Mobile dispatch relay")).not.toBeInTheDocument();
    });

    it("recovery clears the pill", async () => {
        const { SystemHealthIndicator } = await import("./SystemHealthIndicator");
        const { container } = render(<SystemHealthIndicator />);

        await act(async () => {
            healthHandler?.({
                payload: [
                    {
                        component: "keychain",
                        status: "degraded",
                        reason: "Keychain unavailable",
                        remediation: "Relaunch Canopy and click 'Allow'.",
                    },
                ],
            });
        });
        expect(screen.getByRole("button", { name: /1 system issue/ })).toBeInTheDocument();

        await act(async () => {
            healthHandler?.({ payload: [{ component: "keychain", status: "ok" }] });
        });
        expect(container).toBeEmptyDOMElement();
    });
});
