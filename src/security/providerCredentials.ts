export type ProviderLabel = 'OpenAI' | 'Google Gemini' | 'Anthropic' | 'xAI Grok';
export type ManagedProviderId = 'openai' | 'xai';

/** Lowercase OpenClaw provider id, as used by `agent_provider_auth_failed` and
 * the Rust-side auth-failure detection (`openclaw::detect_provider_auth_failure`). */
export type OpenClawProviderId = 'anthropic' | 'openai' | 'gemini' | 'grok';

/**
 * Converts the lowercase id carried on `agent_provider_auth_failed` events and
 * `AuthErrorDialog`'s `provider` prop into the `ProviderLabel` form
 * `getAgentProviderSecretSlot` expects. Centralized so a future new provider
 * only needs updating here, not in every component that bridges the two.
 */
export function openClawProviderIdToLabel(id: OpenClawProviderId): ProviderLabel {
  const labels: Record<OpenClawProviderId, ProviderLabel> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    gemini: 'Google Gemini',
    grok: 'xAI Grok',
  };
  return labels[id];
}

/**
 * Resolve the one Keychain slot an onboarding flow may write for an agent.
 * Keeping this mapping centralized prevents a future UI refactor from silently
 * falling back to a global provider slot.
 */
export function getAgentProviderSecretSlot(agentId: string, provider: ProviderLabel): string {
  const providerSuffix: Record<ProviderLabel, string> = {
    OpenAI: 'openai',
    'Google Gemini': 'gemini',
    Anthropic: 'anthropic',
    'xAI Grok': 'grok',
  };
  return `agent_${agentId}_${providerSuffix[provider]}_key`;
}

export function getManagedProviderId(provider: ProviderLabel | ''): ManagedProviderId | null {
  if (provider === 'OpenAI') return 'openai';
  if (provider === 'xAI Grok') return 'xai';
  return null;
}

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Keep provider secrets inside Rust/Keychain while refreshing an agent runtime. */
export async function syncAgentProviderCredentials(invoke: TauriInvoke, agentId: string): Promise<void> {
  await invoke('sync_agent_api_keys', { agentId });
}
