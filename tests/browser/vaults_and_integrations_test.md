# Browser Test: Vaults & Integrations

## Objective
Verify the functionality of the Integrations View, Web Vault, and Providers Vault (API Keys).

## Prerequisites
- The application should be running in development mode (`npm run dev`).
- The test starts from the Canopy View with the Top Navigation bar visible.

## Steps

1. **Verify Integrations View**
   - Click the **"Integrations"** tab in the Top Navigation bar.
   - Verify that the active view changes to the Integrations list.
   - Look for common integration cards like "Slack", "Gmail", "Calendar", "Apple Photos".
   - Click the **"Connect"** or **"Configure"** button on one of the integration cards (e.g., Slack).
   - Verify that the corresponding connection modal or configuration page opens correctly.

2. **Verify Providers Vault (API Keys)**
   - Navigate to the **"Providers"** or **"Vault"** view. (This might be accessible from the Profile menu or settings).
   - Verify that the vault displays a list of supported LLM Providers (e.g., OpenAI, Google Gemini, Anthropic).
   - Enter a dummy string into an API key input field.
   - Click the **"Save"** or **"Store"** button.
   - Verify that a success indicator appears and the key is marked as stored/configured.

3. **Verify Web Vault (Knowledge Base)**
   - Navigate to the **"Library"** or **"Web Vault"** view.
   - Verify the presence of knowledge collections or the ability to add new knowledge sources.
   - Enter a sample URL or text snippet to ingest into the vault.
   - Click **"Add"** or **"Sync"**.
   - Verify that the new item appears in the list of managed resources.

## Expected Outcome
- The Integrations view loads without errors and connection modals render properly.
- The Providers Vault securely handles API key entry and confirms storage.
- The Web Vault allows users to add and view knowledge resources successfully.
