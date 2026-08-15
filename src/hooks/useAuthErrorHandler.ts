import { useState } from "react";

export interface AuthError {
  message: string;
  provider: "anthropic" | "openai" | "gemini" | "xai";
  raw: any;
}

const AUTH_ERROR_PATTERNS = {
  anthropic: /couldn't sign in to anthropic|no api key found.*anthropic|anthropic.*auth|anthropic.*login|anthropic.*credential|failovererror.*anthropic|agent.*is still missing from the openclaw registry|internal error.*agent/i,
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
