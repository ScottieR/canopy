import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvoke, mockTelemetry, mockEnsureMiniApps, mockWorldState } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockTelemetry: vi.fn(),
  mockEnsureMiniApps: vi.fn(),
  mockWorldState: {
    selectedAgent: null as string | null,
    agents: [
      {
        id: 'agent-riz',
        name: 'Riz',
        role: 'coach',
        emoji: '🦞',
        miniApps: [],
        miniAppsLoaded: true,
      },
    ],
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="pairing-qr">{value}</div>,
}));

vi.mock('../../store/worldStore', () => {
  const state = { ...mockWorldState, ensureAgentMiniApps: mockEnsureMiniApps };
  const useWorldStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    {
      getState: () => state,
      setState: (updater: any) => Object.assign(state, typeof updater === 'function' ? updater(state) : updater),
    },
  );
  return { useWorldStore, reportTelemetryEvent: mockTelemetry };
});

import { MobilePairingModal } from './MobilePairingModal';

const legacyPairing = {
  token: 'mobile-token',
  ip: '192.168.1.20',
  port: 3030,
};

const companionPairing = {
  token: 'scoped-token',
  ip: '192.168.1.20',
  port: 3030,
  deviceId: 'device-maya',
  profile: {
    id: 'profile-maya',
    displayName: 'Maya',
    profileType: 'guest',
    contextJson: {},
  },
  experience: 'focused',
  allowedAgentIds: ['agent-riz'],
};

describe('MobilePairingModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'generate_pairing_token') return legacyPairing;
      if (command === 'revoke_pairing_token') return undefined;
      if (command === 'list_companion_assignments') return [];
      if (command === 'create_companion_pairing') return companionPairing;
      throw new Error(`Unexpected invoke: ${command}`);
    });
  });

  it('keeps standard mobile QR pairing as the primary flow', async () => {
    render(
      <MobilePairingModal
        isOpen
        onClose={vi.fn()}
        defaultAgentId="agent-riz"
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Pair Mobile Device' })).toBeInTheDocument();
    expect(await screen.findByText('Scan with the Canopy mobile app')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('generate_pairing_token');
    expect(screen.queryByRole('heading', { name: 'Share an agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share agent' })).not.toBeInTheDocument();
  });

  it('opens directly into scoped sharing when launched from the agent dashboard', async () => {
    render(
      <MobilePairingModal
        isOpen
        onClose={vi.fn()}
        defaultAgentId="agent-riz"
        initialView="share-agent"
      />,
    );

    await screen.findByRole('heading', { name: 'Share an agent' });
    expect(mockInvoke).not.toHaveBeenCalledWith('generate_pairing_token');
    expect(mockInvoke).toHaveBeenCalledWith('revoke_pairing_token');
    expect(mockInvoke).toHaveBeenCalledWith('list_companion_assignments');

    fireEvent.change(screen.getByPlaceholderText('e.g. Maya'), { target: { value: 'Maya' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create share QR' }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('create_companion_pairing', {
        request: {
          displayName: 'Maya',
          profileType: 'guest',
          experience: 'focused',
          allowedAgentIds: ['agent-riz'],
          deviceName: 'iPad',
          context: {},
        },
      });
    });
    expect(await screen.findByText('Maya will see only the selected agent.')).toBeInTheDocument();
    expect(mockTelemetry).toHaveBeenCalledWith('companion_paired', expect.objectContaining({ experience: 'focused' }));
  });
});
