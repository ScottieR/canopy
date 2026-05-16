import React from "react";
import ReactDOM from "react-dom/client";
import App, { CompanionGuide } from "./App";
import { SlackCompanion } from "./components/Companion/SlackCompanion";
import { PasswordsCompanion } from "./components/Companion/PasswordsCompanion";
import { GithubCompanion } from "./components/Companion/GithubCompanion";
import { DiscordCompanion } from "./components/Companion/DiscordCompanion";
import { TelegramCompanion } from "./components/Companion/TelegramCompanion";
import { ChatCompanion } from "./components/Companion/ChatCompanion";
import { BluetoothCompanion } from "./components/Companion/BluetoothCompanion";
import { BrowserPopout } from "./components/BrowserPopout";
import "./styles/globals.css";

const companionType = new URLSearchParams(window.location.search).get("companion");
const browserAgentId = new URLSearchParams(window.location.search).get("browser");
const chatCompanionAgentId = new URLSearchParams(window.location.search).get("chatCompanion");

// ── Global external-link interceptor ──────────────────────────────────────────
//
// Without this, an `<a href="https://...">` rendered inside the chat (or anywhere
// else in the React tree) navigates the CURRENT Tauri webview to that URL. That
// replaces the main app UI with the external page, leaves the macOS traffic-light
// buttons in place — but they now belong to the main window which is showing a
// webpage — and clicking the close button quits the whole app.
//
// Capture-phase click handler routes any external http(s) link to the user's
// default browser via shell.open(). Internal anchors, javascript: links,
// modifier-clicks (cmd-click etc), and explicit target="_self" are left alone so
// they keep their normal in-app behaviour. Each per-page `open(...)` call already
// in the codebase still works — this is just a safety net for anything we didn't
// hand-instrument (most importantly: agent-emitted markdown links).
function installGlobalExternalLinkHandler() {
  document.addEventListener("click", (e) => {
    // Don't interfere if the click already had its default prevented, or used
    // modifier keys (cmd/ctrl/shift/alt all have legitimate UA semantics we
    // don't want to break), or was anything other than a primary-button click.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    // Find the nearest anchor element. Handles cases where the user clicks an
    // icon or span inside a styled link.
    const target = e.target as HTMLElement | null;
    const anchor = target?.closest("a") as HTMLAnchorElement | null;
    if (!anchor) return;

    // Respect explicit author intent.
    const explicitTarget = anchor.getAttribute("target");
    if (explicitTarget === "_self") return;

    const href = anchor.getAttribute("href");
    if (!href) return;

    // Only intercept absolute http/https URLs. Leave mailto:, tel:, javascript:,
    // hash anchors, and same-document relative links to the browser to handle
    // however it normally would (most of them are no-ops inside Tauri anyway).
    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;

    // Don't intercept links that target the app's own dev server / bundle — those
    // are intra-app navigations the React router (or the companion-window URLs)
    // depend on.
    const sameOrigin =
      url.origin === window.location.origin ||
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.protocol === "tauri:";
    if (sameOrigin) return;

    e.preventDefault();
    e.stopPropagation();

    // Open in the system default browser. Dynamic import keeps the Tauri-only
    // module out of the critical bootstrap path for any environment (tests, SSR
    // fallbacks) where it might be absent.
    import("@tauri-apps/plugin-shell")
      .then(({ open }) => open(url.toString()))
      .catch((err) => {
        console.warn("[link-handler] shell.open failed, falling back to window.open:", err);
        window.open(url.toString(), "_blank", "noopener,noreferrer");
      });
  }, { capture: true });
}

// Install only for the main app window — companion windows (Slack/Github/etc.)
// and the BrowserPopout already manage their own link behaviour and depend on
// in-window navigation for OAuth-style flows.
if (!companionType && !browserAgentId && !chatCompanionAgentId) {
  installGlobalExternalLinkHandler();
}

const WindowWrapper = ({ children }: { children: React.ReactNode }) => {
  if (!companionType && !browserAgentId && !chatCompanionAgentId) return <>{children}</>;
  
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
        {children}
      </div>
    </div>
  );
};

const GlobalBrowserListener = () => {
  const poppedOutAgents = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function setupGlobalBrowserListener() {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<any>("browser_stream_frame", async (e) => {
          const agentId = e.payload.agent_id;
          if (!poppedOutAgents.current.has(agentId)) {
            poppedOutAgents.current.add(agentId);
            const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
            new WebviewWindow('browser_' + agentId + '_' + Date.now(), {
              url: `/index.html?browser=${agentId}`,
              title: 'Machine Browser',
              width: 1000,
              height: 700,
              x: window.screen.availWidth / 2 - 500,
              y: window.screen.availHeight / 2 - 350,
              decorations: true,
            });
          }
        });
      } catch (err) {
        console.warn("Global browser stream listener failed", err);
      }
    }
    setupGlobalBrowserListener();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  return null;
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowWrapper>
      {browserAgentId ? (
        <BrowserPopout agentId={browserAgentId} />
      ) : chatCompanionAgentId ? (
        <ChatCompanion />
      ) : companionType === "slack" ? (
        <SlackCompanion />
      ) : companionType === "passwords" ? (
        <PasswordsCompanion />
      ) : companionType === "github" ? (
        <GithubCompanion />
      ) : companionType === "discord" ? (
        <DiscordCompanion />
      ) : companionType === "telegram" ? (
        <TelegramCompanion />
      ) : companionType === "bluetooth" ? (
        <BluetoothCompanion />
      ) : companionType ? (
        <CompanionGuide type={companionType} />
      ) : (
        <>
          <GlobalBrowserListener />
          <App />
        </>
      )}
    </WindowWrapper>
  </React.StrictMode>
);
