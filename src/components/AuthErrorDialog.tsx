import React, { useState } from "react";
import { X } from "lucide-react";
import { PasswordInput } from "./shared/PasswordInput";

interface AuthErrorDialogProps {
  error: string;
  provider: "anthropic" | "openai" | "gemini" | "xai";
  onRetry: (apiKey: string) => void | Promise<void>;
  onCancel: () => void;
}

const PROVIDER_LINKS = {
  anthropic: "https://console.anthropic.com/account/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/app/apikey",
  xai: "https://console.x.ai/",
};

const PROVIDER_NAMES = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  xai: "xAI Grok",
};

export const AuthErrorDialog: React.FC<AuthErrorDialogProps> = ({
  error,
  provider,
  onRetry,
  onCancel,
}) => {
  const [apiKey, setApiKey] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const handleRetry = async () => {
    if (!apiKey.trim()) {
      setErrorMsg("Please enter your API key");
      return;
    }

    setIsLoading(true);
    setErrorMsg("");

    try {
      await onRetry(apiKey);
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: "var(--surface-card)",
          borderRadius: 16,
          border: "1px solid var(--border-subtle)",
          padding: 32,
          maxWidth: 500,
          width: "90%",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 24,
          }}
        >
          <h2
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: "var(--text-main)",
              margin: 0,
            }}
          >
            Authentication Error
          </h2>
          <button
            onClick={onCancel}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-sub)",
              padding: 0,
            }}
          >
            <X size={20} />
          </button>
        </div>

        <div
          style={{
            background: "rgba(229,115,115,0.08)",
            border: "1px solid rgba(229,115,115,0.3)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 24,
            fontSize: 13,
            color: "var(--text-sub)",
            lineHeight: 1.5,
          }}
        >
          {error ||
            `Your ${PROVIDER_NAMES[provider]} credentials are missing or expired.`}
        </div>

        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-main)",
              marginBottom: 8,
            }}
          >
            {PROVIDER_NAMES[provider]} API Key
          </label>
          <PasswordInput
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setErrorMsg("");
            }}
            placeholder={`Enter your ${PROVIDER_NAMES[provider]} API key`}
            style={{
              width: "100%",
              padding: "10px 14px",
              borderRadius: 8,
              border: errorMsg
                ? "1px solid #E57373"
                : "1px solid var(--border-subtle)",
              fontFamily: "monospace",
              fontSize: 13,
              boxSizing: "border-box",
              fontWeight: 400,
            }}
          />
          {errorMsg && (
            <div style={{ fontSize: 12, color: "#E57373", marginTop: 8 }}>
              {errorMsg}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 24 }}>
          <a
            href={PROVIDER_LINKS[provider]}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 13,
              color: "#3c6663",
              textDecoration: "none",
              fontWeight: 600,
              display: "inline-block",
              marginBottom: 16,
            }}
            onAuxClick={(e) => {
              // Prevent default middle-click behavior
              e.preventDefault();
            }}
            onClick={async (e) => {
              // Open in new window via API instead of default link behavior
              // This gives better control over the window
              e.preventDefault();
              try {
                const shell = await import("@tauri-apps/plugin-shell");
                await shell.open(PROVIDER_LINKS[provider]);
              } catch {
                window.open(PROVIDER_LINKS[provider], "_blank");
              }
            }}
          >
            Get your {PROVIDER_NAMES[provider]} API key →
          </a>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <button
            onClick={handleRetry}
            disabled={isLoading}
            style={{
              flex: 1,
              padding: "12px 16px",
              borderRadius: 8,
              border: "none",
              background: isLoading ? "#ccc" : "#3c6663",
              color: "var(--surface-card)",
              fontSize: 14,
              fontWeight: 600,
              cursor: isLoading ? "not-allowed" : "pointer",
              opacity: isLoading ? 0.6 : 1,
            }}
          >
            {isLoading ? "Connecting..." : "Retry"}
          </button>
          <button
            onClick={onCancel}
            disabled={isLoading}
            style={{
              flex: 1,
              padding: "12px 16px",
              borderRadius: 8,
              border: "1px solid var(--border-subtle)",
              background: "transparent",
              color: "var(--text-sub)",
              fontSize: 14,
              fontWeight: 600,
              cursor: isLoading ? "not-allowed" : "pointer",
              opacity: isLoading ? 0.6 : 1,
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
