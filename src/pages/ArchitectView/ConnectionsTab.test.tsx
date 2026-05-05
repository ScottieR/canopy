import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionsTab } from './ConnectionsTab';

vi.mock('@tauri-apps/api/event', () => {
  return {
    listen: vi.fn().mockImplementation(() => Promise.resolve(vi.fn()))
  };
});

// Mock the global invoke
const mockInvoke = vi.fn().mockImplementation((cmd: string) => {
  if (cmd === 'get_connectors_config') {
    return Promise.resolve([
      { id: 'github', name: 'Github', isVisible: true, isSuggested: true, icon: 'github' },
      { id: 'telegram', name: 'Telegram', isVisible: true, isSuggested: true, icon: 'send' },
      { id: 'discord', name: 'Discord', isVisible: true, isSuggested: true, icon: 'message-circle' }
    ]);
  }
  if (cmd === 'get_available_models') {
    return Promise.resolve([{ id: 'mock', name: 'Mock Model', provider: 'Mock', strategy: 'Mock Strategy' }]);
  }
  return Promise.resolve("Success");
});

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
    transformCallback: vi.fn(),
    listen: vi.fn().mockResolvedValue(vi.fn()),
  };
});

describe('ConnectionsTab Configuration Routing', () => {
  const mockAgent = {
    id: "test-agent-123",
    name: "TestAgent",
    role: "Assistant",
    personality: { name: "TestAgent", communication_style: "Polite" },
    integrations: [],
    permissions: [],
    tools: {},
    visual_identity: { accessories: [] }
  } as any;

  it('routes github token submission to configure_github instead of store_secret_cmd', async () => {
    render(<ConnectionsTab agent={mockAgent} />);
    
    await waitFor(() => {
      expect(screen.getByText('Github')).toBeInTheDocument();
    });
    const githubBox = screen.getByText('Github').closest('div[style*="cursor: pointer"]');
    if (githubBox) fireEvent.click(githubBox);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('ghp_...')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('ghp_...');
    fireEvent.change(input, { target: { value: 'ghp_test_token_123' } });

    const saveBtn = screen.getByText('Save');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("configure_github", { personalAccessToken: 'ghp_test_token_123' });
      expect(mockInvoke).not.toHaveBeenCalledWith("store_secret_cmd", expect.anything());
    });
  });

  it('routes telegram token submission to configure_telegram', async () => {
    render(<ConnectionsTab agent={mockAgent} />);
    
    await waitFor(() => {
      expect(screen.getByText('Telegram')).toBeInTheDocument();
    });
    const telegramBox = screen.getByText('Telegram').closest('div[style*="cursor: pointer"]');
    if (telegramBox) fireEvent.click(telegramBox);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('ghp_...')).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText('ghp_...');
    fireEvent.change(input, { target: { value: 'tel_token_123' } });

    const saveBtn = screen.getByText('Save');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("configure_telegram", { botToken: 'tel_token_123' });
    });
  });

  it('routes discord token submission to configure_discord', async () => {
    render(<ConnectionsTab agent={mockAgent} />);

    await waitFor(() => {
      expect(screen.getByText('Discord')).toBeInTheDocument();
    });
    const discordBox = screen.getByText('Discord').closest('div[style*="cursor: pointer"]');
    if (discordBox) fireEvent.click(discordBox);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('ghp_...')).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText('ghp_...');
    fireEvent.change(input, { target: { value: 'dis_token_123' } });

    const saveBtn = screen.getByText('Save');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("configure_discord", { botToken: 'dis_token_123' });
    });
  });
});
