import { describe, expect, it } from "vitest";

import {
  detectInsecureCredentialAdvice,
  recoverSecureConnectionRequest,
  SECURE_CREDENTIAL_REDIRECT_MESSAGE,
} from "./credentialAdvice";

describe("detectInsecureCredentialAdvice", () => {
  it("flags instructions to put secrets in a .env file", () => {
    expect(
      detectInsecureCredentialAdvice(
        "Put your access token and client secret in a .env file in the workspace so I can use them.",
      ),
    ).toMatchObject({ kind: "env_secret" });
  });

  it("flags instructions to share secrets directly in chat", () => {
    expect(
      detectInsecureCredentialAdvice(
        "Reply with your OAuth token and I can finish the setup from here.",
      ),
    ).toMatchObject({ kind: "chat_secret" });
  });

  it("flags instructions to save secrets into workspace files", () => {
    expect(
      detectInsecureCredentialAdvice(
        "Save the API key in a workspace file and I will read it from there.",
      ),
    ).toMatchObject({ kind: "workspace_secret" });
  });

  it("does not flag prohibitions against insecure handling", () => {
    expect(
      detectInsecureCredentialAdvice(
        "Do not put your token in a .env file. Use the secure connection flow instead.",
      ),
    ).toBeNull();
    expect(
      detectInsecureCredentialAdvice(
        "Never paste your password into chat. I need to open the secure setup flow.",
      ),
    ).toBeNull();
  });

  it("keeps the redirect copy explicit", () => {
    expect(SECURE_CREDENTIAL_REDIRECT_MESSAGE).toContain("secure connection flow");
    expect(SECURE_CREDENTIAL_REDIRECT_MESSAGE).toContain("`.env`");
  });

  it("recovers known direct companions from blocked advice", () => {
    expect(
      recoverSecureConnectionRequest(
        "Paste your GitHub token here and I'll finish the repo setup.",
      ),
    ).toMatchObject({
      companionType: "github",
      label: "GitHub",
    });
  });

  it("recovers custom OAuth providers with extracted metadata", () => {
    expect(
      recoverSecureConnectionRequest(
        "Put your access token in a .env file. Use Plaid with auth at https://plaid.com/oauth/authorize and token exchange at https://plaid.com/oauth/token. scopes=transactions.read,accounts.read",
      ),
    ).toMatchObject({
      companionType: "custom_oauth",
      label: "Plaid",
      params: {
        providerName: "Plaid",
        authUrl: "https://plaid.com/oauth/authorize",
        tokenUrl: "https://plaid.com/oauth/token",
        scopes: "transactions.read,accounts.read",
        accessMode: "read",
      },
    });
  });

  it("returns null when it cannot infer a safe recovery target", () => {
    expect(
      recoverSecureConnectionRequest(
        "Paste your token here.",
      ),
    ).toBeNull();
  });
});
