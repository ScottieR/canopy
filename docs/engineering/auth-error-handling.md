# Authentication Error Handling Integration Guide

## Overview
This guide explains how to integrate authentication error handling into Canopy components so users can re-authenticate when provider credentials expire.

## Problem
When OpenClaw agents try to use LLM providers (Anthropic, OpenAI, Google Gemini, xAI), they may fail with authentication errors like:
```
"Couldn't sign in to anthropic. Your saved login looks expired or no longer works."
```

Previously, these errors would appear as generic failures without user recourse. Now we can detect these errors and prompt users to provide new credentials.

## Solution Components

### 1. `AuthErrorDialog` Component
**Location**: `src/components/AuthErrorDialog.tsx`

A modal dialog that:
- Displays the authentication error
- Prompts user for API key
- Links to the provider's key generation page
- Stores credentials securely
- Retries the operation

**Usage**:
```tsx
import { AuthErrorDialog } from './AuthErrorDialog';

// In your component
{showAuthDialog && authError && (
  <AuthErrorDialog
    error={authError.message}
    provider={authError.provider}
    onRetry={handleAuthRetry}
    onCancel={() => setShowAuthDialog(false)}
  />
)}
```

### 2. `useAuthErrorHandler` Hook
**Location**: `src/hooks/useAuthErrorHandler.ts`

A custom hook that:
- Detects authentication errors in error messages
- Manages auth dialog visibility
- Provides methods to handle and clear errors

**Usage**:
```tsx
import { useAuthErrorHandler } from '../hooks/useAuthErrorHandler';

function MyComponent() {
  const { authError, showAuthDialog, handleAuthError, clearAuthError } = useAuthErrorHandler();

  const handleRequest = async () => {
    try {
      // Make API call
      await someApiCall();
    } catch (error) {
      handleAuthError(error);
    }
  };

  return (
    <>
      {showAuthDialog && authError && (
        <AuthErrorDialog
          error={authError.message}
          provider={authError.provider}
          onRetry={handleAuthRetry}
          onCancel={clearAuthError}
        />
      )}
      <button onClick={handleRequest}>Make Request</button>
    </>
  );
}
```

## Integration Steps

### Step 1: Wrap API Calls
In components that make requests to agents, wrap calls with error handling:

```tsx
import { useAuthErrorHandler } from '../hooks/useAuthErrorHandler';
import { AuthErrorDialog } from '../components/AuthErrorDialog';

function AgentChatComponent() {
  const { authError, showAuthDialog, handleAuthError, clearAuthError } = useAuthErrorHandler();

  const sendMessage = async (message: string) => {
    try {
      const response = await api.sendMessage(agentId, message);
      // Handle success
    } catch (error) {
      handleAuthError(error); // This will show auth dialog if auth error
    }
  };

  const handleAuthRetry = async (apiKey: string) => {
    try {
      // Store the new API key
      await storeCredential(authError.provider, apiKey);
      
      // Retry the original operation
      await sendMessage(lastMessage);
      clearAuthError();
    } catch (error) {
      handleAuthError(error);
    }
  };

  return (
    <>
      {showAuthDialog && authError && (
        <AuthErrorDialog
          error={authError.message}
          provider={authError.provider}
          onRetry={handleAuthRetry}
          onCancel={clearAuthError}
        />
      )}
      {/* Rest of component */}
    </>
  );
}
```

### Step 2: Store Credentials
Use the existing credential system in `src/security/providerCredentials.ts`:

```tsx
import { getAgentProviderSecretSlot } from '../security/providerCredentials';

async function storeCredential(provider: string, apiKey: string) {
  const slot = getAgentProviderSecretSlot(agentId, provider);
  // Use Tauri to store in keychain
  await invoke('set_keychain_item', { key: slot, value: apiKey });
}
```

### Step 3: Sync Credentials with Agent
After storing, sync credentials back to the agent runtime:

```tsx
import { syncAgentProviderCredentials } from '../security/providerCredentials';

async function handleAuthRetry(apiKey: string) {
  try {
    // Store the new API key
    await storeCredential(authError.provider, apiKey);
    
    // Sync credentials to agent runtime
    await syncAgentProviderCredentials(invoke, agentId);
    
    // Retry the original operation
    await retryOriginalOperation();
    clearAuthError();
  } catch (error) {
    handleAuthError(error);
  }
}
```

## Error Detection Patterns
The `detectAuthError` function looks for these patterns:

**Anthropic**:
- `Couldn't sign in to anthropic`
- `No API key found for provider "anthropic"`
- `anthropic.*login.*expired`

**OpenAI**:
- `openai.*unauthorized`
- `openai.*invalid.*key`

**Google Gemini**:
- `gemini.*unauthorized`
- `google.*api.*key`

**xAI Grok**:
- `xai.*unauthorized`
- `grok.*api.*key`

You can extend these patterns in `src/hooks/useAuthErrorHandler.ts`.

## Security Considerations
1. **Keychain Storage**: API keys are stored in the system keychain via Tauri, not in localStorage
2. **No Logging**: API keys are never logged or displayed in console
3. **Secure Input**: Password input type masks the key as user types
4. **Verified Storage**: Credentials are synced to agent runtime for verification

## Testing
To test authentication error handling:

1. Clear or revoke your API key in the provider dashboard
2. Try to send a message to an agent
3. You should see the auth dialog appear
4. Enter a valid API key
5. Click "Authenticate"
6. The original operation should retry and succeed

## Common Issues

### Dialog Doesn't Appear
- Ensure the error message matches one of the `AUTH_ERROR_PATTERNS`
- Check console for the actual error message
- Add the pattern to the appropriate provider in `AUTH_ERROR_PATTERNS`

### Credentials Not Persisting
- Verify the Tauri `set_keychain_item` command is available
- Check that `syncAgentProviderCredentials` is called after storing
- Verify the keychain slot key matches between storage and agent

### Dialog Appears But Retry Fails
- The new API key may be invalid
- The provider may have additional restrictions
- Check the provider's documentation for current requirements

## Future Enhancements
1. **One-tap OAuth**: Direct OAuth flow for providers that support it
2. **Credential Validation**: Test credentials before storing
3. **Expiration Warnings**: Proactively warn before credentials expire
4. **Multiple Credentials**: Support multiple API keys per provider
5. **Provider Status Dashboard**: Show which providers are authenticated
