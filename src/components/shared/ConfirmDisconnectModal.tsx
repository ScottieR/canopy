import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

/**
 * Reusable disconnect confirmation modal.
 *
 * Renders a centered overlay describing exactly what gets wiped if the user proceeds:
 *  - "tokens" copy   — names the saved credentials that will be deleted from keychain
 *  - "bindings" copy — names the agents that will lose access if any are bound
 *
 * The host component is responsible for actually invoking the Tauri `disconnect_*`
 * command on confirm. This component only handles UI + user intent.
 *
 * Open/closed state is controlled (`open` prop). Use `useState` in the parent.
 *
 * Example:
 *
 *   const [confirmOpen, setConfirmOpen] = useState(false);
 *   ...
 *   <ConfirmDisconnectModal
 *     open={confirmOpen}
 *     integrationName="Slack"
 *     tokens={["Slack Bot Token", "Slack App Token"]}
 *     boundAgents={["Sloane", "Atlas"]}
 *     onCancel={() => setConfirmOpen(false)}
 *     onConfirm={async () => {
 *       setConfirmOpen(false);
 *       await invoke("disconnect_slack_global");
 *     }}
 *   />
 */

export interface ConfirmDisconnectModalProps {
    /** Whether the modal is visible. */
    open: boolean;
    /** Display name for the integration (e.g. "Slack", "Telegram", "GitHub"). */
    integrationName: string;
    /** Human-readable names of the credentials that will be deleted from the keychain. */
    tokens: string[];
    /**
     * Names of agents that currently use this connection and will lose access. Pass an
     * empty array if there are none (e.g. global integration with no per-agent binding).
     */
    boundAgents?: string[];
    /** Optional extra warning line (e.g. "This will also remove the gh wrapper script"). */
    extraNote?: string;
    /** Called when the user confirms. The host should invoke the Tauri disconnect command. */
    onConfirm: () => void | Promise<void>;
    /** Called when the user cancels (clicks X or "Keep Connected"). */
    onCancel: () => void;
    /** Set to true to disable the confirm button while the disconnect is in flight. */
    busy?: boolean;
}

export function ConfirmDisconnectModal({
    open,
    integrationName,
    tokens,
    boundAgents = [],
    extraNote,
    onConfirm,
    onCancel,
    busy = false,
}: ConfirmDisconnectModalProps) {
    if (!open) return null;

    const hasBindings = boundAgents.length > 0;

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-disconnect-title"
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0, 0, 0, 0.55)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 9999,
            }}
            onClick={(e) => {
                // Backdrop click cancels — but only if the click started AND ended on the backdrop.
                if (e.target === e.currentTarget && !busy) onCancel();
            }}
        >
            <div
                style={{
                    background: '#1a1f1a',
                    color: '#e8efe8',
                    border: '1px solid #2d3a2d',
                    borderRadius: 12,
                    padding: 24,
                    width: 440,
                    maxWidth: 'calc(100vw - 32px)',
                    boxShadow: '0 12px 48px rgba(0, 0, 0, 0.5)',
                    fontFamily: 'inherit',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{
                            background: '#3a2a1a',
                            borderRadius: '50%',
                            width: 36,
                            height: 36,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                        }}>
                            <AlertTriangle size={18} color="#f0a060" />
                        </div>
                        <h2
                            id="confirm-disconnect-title"
                            style={{ margin: 0, fontSize: 17, fontWeight: 600 }}
                        >
                            Disconnect {integrationName}?
                        </h2>
                    </div>
                    <button
                        onClick={onCancel}
                        disabled={busy}
                        aria-label="Close"
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#8a9a8a',
                            cursor: busy ? 'not-allowed' : 'pointer',
                            padding: 4,
                            display: 'flex',
                        }}
                    >
                        <X size={18} />
                    </button>
                </div>

                <p style={{ margin: '0 0 14px 0', fontSize: 14, lineHeight: 1.5, color: '#c8d0c8' }}>
                    This will remove the saved tokens for <strong>{integrationName}</strong>
                    {hasBindings ? <> and stop {boundAgents.length === 1 ? 'this agent' : 'these agents'} from using it</> : null}.
                    You'll need to reconnect to use it again.
                </p>

                <div style={{
                    background: '#0f130f',
                    border: '1px solid #2a352a',
                    borderRadius: 8,
                    padding: 12,
                    marginBottom: hasBindings || extraNote ? 12 : 18,
                }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#8a9a8a', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                        Tokens to be wiped
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#d0d8d0' }}>
                        {tokens.map((t, i) => (<li key={i} style={{ marginBottom: 2 }}>{t}</li>))}
                    </ul>
                </div>

                {hasBindings && (
                    <div style={{
                        background: '#0f130f',
                        border: '1px solid #2a352a',
                        borderRadius: 8,
                        padding: 12,
                        marginBottom: extraNote ? 12 : 18,
                    }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#8a9a8a', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                            {boundAgents.length === 1 ? 'Agent that will lose access' : 'Agents that will lose access'}
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#d0d8d0' }}>
                            {boundAgents.map((a, i) => (<li key={i} style={{ marginBottom: 2 }}>{a}</li>))}
                        </ul>
                    </div>
                )}

                {extraNote && (
                    <p style={{ margin: '0 0 18px 0', fontSize: 12, color: '#8a9a8a', lineHeight: 1.5 }}>
                        {extraNote}
                    </p>
                )}

                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                    <button
                        onClick={onCancel}
                        disabled={busy}
                        style={{
                            background: 'transparent',
                            color: '#c8d0c8',
                            border: '1px solid #2d3a2d',
                            borderRadius: 6,
                            padding: '8px 16px',
                            fontSize: 13,
                            cursor: busy ? 'not-allowed' : 'pointer',
                        }}
                    >
                        Keep Connected
                    </button>
                    <button
                        onClick={onConfirm}
                        disabled={busy}
                        style={{
                            background: busy ? '#5a3030' : '#a04040',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 6,
                            padding: '8px 16px',
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: busy ? 'not-allowed' : 'pointer',
                            opacity: busy ? 0.7 : 1,
                        }}
                    >
                        {busy ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default ConfirmDisconnectModal;
