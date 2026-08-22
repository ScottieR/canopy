import { useState } from "react";

export interface AuthError {
  message: string;
  provider: "anthropic" | "openai" | "gemini" | "xai";
  raw: any;
}

// Every pattern here must be "auth-shaped" (name a provider alongside a sign-in/
// key/credential phrase) before attributing it to that provider — mirrors the
// gating in detect_provider_auth_failure (src-tauri/src/openclaw.rs). The
// anthropic pattern used to also match "agent ... is still missing from the
// openclaw registry" and any "internal error ... agent" text: both are generic,
// non-auth failures (e.g. a gateway registration race) that have nothing to do
// with an Anthropic key, so they mislabeled unrelated errors as "no Anthropic
// API key" and popped the wrong reconnect dialog.
const AUTH_ERROR_PATTERNS = {
  anthropic: /couldn't sign in to anthropic|no api key found.*anthropic|anthropic.*auth|anthropic.*login|anthropic.*credential|failovererror.*anthropic/i,
  openai: /couldn't sign in to openai|no api key found.*openai|openai.*auth|openai.*login|openai.*credential|failovererror.*openai/i,
  gemini: /couldn't sign in to gemini|no api key found.*gemini|google.*auth|gemini.*login|gemini.*credential|failovererror.*gemini/i,
  xai: /couldn't sign in to.*grok|no api key found.*grok|xai.*auth|grok.*login|xai.*credential|failovererror.*grok/i,
};

export const useAuthErrorHandler = () => {
  const [authError, setAuthError] = useState<AuthError | null>(null);
  const [showAuthDialog, setShowAuthDialog] = useState(false);

  const handleAuthError = (error: any): AuthError | null => {
    const errorStr = String(error || "");

    for (const [provider, pattern] of Object.entries(AUTH_ERROR_PATTERNS)) {
      if (pattern.test(errorStr)) {
        const newError: AuthError = {
          message: errorStr,
          provider: provider as AuthError["provider"],
          raw: error,
        };
        // Tell the global agent_provider_auth_failed modal (AgentRequestNotifier)
        // to stand down: the same gateway failure also reaches the Rust event
        // path, and one dead key must not pop two dialogs at once.
        try { sessionStorage.setItem("canopy:auth-error-inline-at", String(Date.now())); } catch (e) {}
        setAuthError(newError);
        setShowAuthDialog(true);
        return newError;
      }
    }

    return null;
  };

  const clearAuthError = () => {
    setAuthError(null);
    setShowAuthDialog(false);
  };

  return {
    authError,
    showAuthDialog,
    handleAuthError,
    clearAuthError,
    setShowAuthDialog,
  };
};
