import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BookOpen, Code2, Share2, Smartphone, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { MiniApp, useWorldStore, reportTelemetryEvent } from '../../store/worldStore';

interface MobilePairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultAgentId?: string;
  initialView?: 'pair-device' | 'share-agent';
}

interface CompanionProfile {
  id: string;
  displayName: string;
  profileType: 'child' | 'adult' | 'guest';
  contextJson: Record<string, unknown>;
}

interface PairingData {
  token: string;
  ip: string;
  port: number;
  deviceId: string;
  profile: CompanionProfile;
  experience: 'focused' | 'learning';
  allowedAgentIds: string[];
}

interface MobilePairingData {
  token: string;
  ip: string;
  port: number;
}

interface CompanionAssignment {
  grant: {
    deviceId: string;
    profileId: string;
    deviceName: string;
    experience: 'focused' | 'learning';
    allowedAgentIds: string[];
    revoked: boolean;
    lastSeenAt?: string | null;
  };
  profile: CompanionProfile;
}

interface CompanionReport {
  id: string;
  reportJson: {
    summary?: string;
    strengths?: string[];
    needsPractice?: string[];
    recommendedNext?: string[];
    confidence?: number;
  };
}

export const MobilePairingModal: React.FC<MobilePairingModalProps> = ({
  isOpen,
  onClose,
  defaultAgentId,
  initialView = 'pair-device',
}) => {
  const agents = useWorldStore((state) => state.agents);
  const ensureAgentMiniApps = useWorldStore((state) => state.ensureAgentMiniApps);
  const [view, setView] = useState<'pair-device' | 'share-agent'>('pair-device');
  const [mobilePairingData, setMobilePairingData] = useState<MobilePairingData | null>(null);
  const [pairingData, setPairingData] = useState<PairingData | null>(null);
  const [assignments, setAssignments] = useState<CompanionAssignment[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [deviceName, setDeviceName] = useState('iPad');
  const [experience, setExperience] = useState<'focused' | 'learning'>('focused');
  const [profileType, setProfileType] = useState<'child' | 'adult' | 'guest'>('guest');
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [profileContext, setProfileContext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<CompanionReport | null>(null);
  const [reportLoadingFor, setReportLoadingFor] = useState<string | null>(null);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [publishingAppKey, setPublishingAppKey] = useState<string | null>(null);
  const [publishedAppKeys, setPublishedAppKeys] = useState<Set<string>>(new Set());

  const refreshAssignments = async () => {
    const result = await invoke<CompanionAssignment[]>('list_companion_assignments');
    setAssignments(result);
  };

  const generateMobilePairing = async () => {
    setMobilePairingData(null);
    setError(null);
    try {
      const data = await invoke<MobilePairingData>('generate_pairing_token');
      setMobilePairingData(data);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    if (!isOpen) {
      setView('pair-device');
      setMobilePairingData(null);
      setPairingData(null);
      setError(null);
      invoke('revoke_pairing_token').catch(console.error);
      return;
    }

    setView(initialView);
    setMobilePairingData(null);
    setPairingData(null);
    setEditingDeviceId(null);
    setReport(null);
    setError(null);
    setSelectedAgentIds(defaultAgentId ? [defaultAgentId] : agents[0]?.id ? [agents[0].id] : []);
    if (initialView === 'share-agent') {
      // A scoped share must never inherit a broad mobile pairing token.
      invoke('revoke_pairing_token').catch(console.error);
      refreshAssignments().catch((err) => setError(String(err)));
    } else {
      generateMobilePairing();
    }
  }, [isOpen, defaultAgentId, initialView]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const activeAssignments = useMemo(
    () => assignments.filter((assignment) => !assignment.grant.revoked),
    [assignments],
  );

  useEffect(() => {
    if (!isOpen || view !== 'share-agent') return;
    const agentIds = new Set(activeAssignments.flatMap(assignment => assignment.grant.allowedAgentIds));
    for (const agentId of agentIds) void ensureAgentMiniApps(agentId);
    return () => {
      const selected = useWorldStore.getState().selectedAgent;
      useWorldStore.setState(state => ({
        agents: state.agents.map(agent =>
          agentIds.has(agent.id) && agent.id !== selected
            ? { ...agent, miniApps: undefined, miniAppsLoaded: false }
            : agent
        ),
      }));
    };
  }, [activeAssignments, ensureAgentMiniApps, isOpen, view]);

  const selectExperience = (next: 'focused' | 'learning') => {
    setExperience(next);
    setProfileType(next === 'learning' ? 'child' : 'guest');
    if (next === 'learning' && selectedAgentIds.length > 1) {
      setSelectedAgentIds(selectedAgentIds.slice(0, 1));
    }
  };

  const toggleAgent = (agentId: string) => {
    if (experience === 'learning') {
      setSelectedAgentIds([agentId]);
      return;
    }
    setSelectedAgentIds((current) =>
      current.includes(agentId)
        ? current.filter((id) => id !== agentId)
        : [...current, agentId],
    );
  };

  const createPairing = async () => {
    if (!displayName.trim()) {
      setError('Enter the name of the person using this device.');
      return;
    }
    if (selectedAgentIds.length === 0) {
      setError('Choose at least one agent to share.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const context = profileContext.trim()
        ? { parentNotes: profileContext.trim() }
        : {};
      if (editingDeviceId) {
        await invoke('update_companion_assignment', {
          request: {
            deviceId: editingDeviceId,
            displayName: displayName.trim(),
            deviceName: deviceName.trim() || 'iPad',
            profileType,
            experience,
            allowedAgentIds: selectedAgentIds,
            context,
          },
        });
        setEditingDeviceId(null);
        setPairingData(null);
        await refreshAssignments();
        return;
      }
      const data = await invoke<PairingData>('create_companion_pairing', {
        request: {
          displayName: displayName.trim(),
          profileType,
          experience,
          allowedAgentIds: selectedAgentIds,
          deviceName: deviceName.trim() || 'iPad',
          context,
        },
      });
      setPairingData(data);
      // Companion/mobile pairing usage — device metadata only, no names or content.
      reportTelemetryEvent('companion_paired', { profileType, experience });
      await refreshAssignments();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const editAssignment = (assignment: CompanionAssignment) => {
    setEditingDeviceId(assignment.grant.deviceId);
    setPairingData(null);
    setDisplayName(assignment.profile.displayName);
    setDeviceName(assignment.grant.deviceName);
    setExperience(assignment.grant.experience);
    setProfileType(assignment.profile.profileType);
    setSelectedAgentIds(assignment.grant.allowedAgentIds);
    setProfileContext(String(assignment.profile.contextJson?.parentNotes ?? ''));
  };

  const revoke = async (deviceId: string) => {
    await invoke('revoke_companion_assignment', { deviceId });
    await refreshAssignments();
  };

  const generateReport = async (assignment: CompanionAssignment) => {
    const agentId = assignment.grant.allowedAgentIds[0];
    if (!agentId) return;
    setReportLoadingFor(assignment.grant.deviceId);
    setReport(null);
    setError(null);
    try {
      const result = await invoke<CompanionReport>('generate_companion_report', {
        profileId: assignment.profile.id,
        agentId,
      });
      setReport(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setReportLoadingFor(null);
    }
  };

  const publishMiniApp = async (
    assignment: CompanionAssignment,
    agentId: string,
    app: MiniApp,
  ) => {
    const activeVersion = app.versions?.find((version) => version.id === app.activeVersionId)
      ?? app.versions?.[0];
    if (!activeVersion) return;

    const publishKey = `${assignment.profile.id}:${agentId}:${app.id}:${activeVersion.id}`;
    setPublishingAppKey(publishKey);
    setError(null);
    try {
      let html = activeVersion.htmlContent ?? app.htmlContent ?? '';
      if (!html && activeVersion.entrypoint) {
        html = await invoke<string>('read_workspace_file', {
          agentId,
          filename: activeVersion.entrypoint,
        });
      }
      if (!html.trim()) {
        throw new Error('This mini-app has no publishable HTML content.');
      }
      await invoke('publish_companion_resource', {
        request: {
          id: `companion_${assignment.profile.id}_${app.id}`,
          profileId: assignment.profile.id,
          agentId,
          resourceType: 'mini_app',
          title: app.name,
          content: {
            component: 'HtmlMiniApp',
            props: {
              html,
              height: 520,
              sourceAppId: app.id,
              sourceVersionId: activeVersion.id,
            },
          },
        },
      });
      setPublishedAppKeys((current) => new Set(current).add(publishKey));
    } catch (err) {
      setError(String(err));
    } finally {
      setPublishingAppKey(null);
    }
  };

  if (!isOpen) return null;

  if (view === 'pair-device') {
    return (
      <div
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-5"
        style={{ fontFamily: "'Manrope', system-ui, -apple-system, sans-serif" }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-pairing-title"
          className="w-full max-w-md overflow-hidden rounded-[20px] border border-black/10 bg-[#faf9f6] shadow-2xl"
        >
          <div className="flex items-center gap-3 border-b border-black/10 bg-[#f3f1ec] px-5 py-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#218380]/10 text-[#218380]">
              <Smartphone size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="mobile-pairing-title"
                className="m-0 text-xl font-bold text-[#303330]"
                style={{ fontFamily: "'Noto Serif', Georgia, serif" }}
              >
                Pair Mobile Device
              </h2>
              <p className="m-0 mt-0.5 text-xs text-[#636e72]">Link the Canopy app on your phone or iPad.</p>
            </div>
            <button
              type="button"
              aria-label="Close mobile pairing"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg border-0 bg-transparent text-[#7a8381] hover:bg-black/5 hover:text-[#303330]"
            >
              <X size={19} />
            </button>
          </div>

          <div className="flex min-h-[360px] flex-col items-center justify-center px-7 py-7 text-center">
            {error ? (
              <div role="alert" className="w-full rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                <div className="mb-3">{error}</div>
                <button
                  type="button"
                  onClick={generateMobilePairing}
                  className="rounded-lg border-0 bg-[#218380] px-3.5 py-2 text-xs font-semibold text-white"
                >
                  Try again
                </button>
              </div>
            ) : !mobilePairingData ? (
              <div className="text-sm text-[#636e72] animate-pulse">Generating a secure pairing code…</div>
            ) : (
              <>
                <div className="mb-5 rounded-2xl border border-[#218380]/15 bg-white p-3 shadow-lg">
                  <QRCodeSVG
                    value={JSON.stringify(mobilePairingData)}
                    size={200}
                    level="H"
                    includeMargin
                  />
                </div>
                <p className="m-0 mb-1.5 text-[15px] font-bold text-[#303330]">Scan with the Canopy mobile app</p>
                <p className="m-0 max-w-xs text-[13px] leading-relaxed text-[#636e72]">
                  Make sure this Mac and your mobile device are connected to the same Wi-Fi network.
                </p>
                <div className="mt-5 flex items-center gap-2 rounded-full bg-[#f0eee9] px-3 py-1.5 font-mono text-[11px] text-[#7a8381]">
                  <span className="h-2 w-2 rounded-full bg-[#4a9e96]" />
                  Relay active on {mobilePairingData.ip}:{mobilePairingData.port}
                </div>
              </>
            )}
          </div>

        </div>
      </div>
    );
  }

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-5"
      style={{ fontFamily: "'Manrope', system-ui, -apple-system, sans-serif" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-agent-title"
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-[20px] border border-black/10 bg-[#faf9f6] shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-black/10 bg-[#f3f1ec] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-[#218380]/10 p-2.5 text-[#218380]">
              <Share2 size={19} />
            </div>
            <div>
              <h2 id="share-agent-title" className="m-0 text-xl font-bold text-[#303330]" style={{ fontFamily: "'Noto Serif', Georgia, serif" }}>Share an agent</h2>
              <p className="m-0 mt-0.5 text-xs text-[#636e72]">Give another person access to selected agents, without sharing your full mobile workspace.</p>
            </div>
          </div>
          <button type="button" aria-label="Close agent sharing" onClick={onClose} className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg border-0 bg-transparent text-[#7a8381] hover:bg-black/5 hover:text-[#303330]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          <div>
            <div className="grid grid-cols-2 gap-3 mb-5">
              <button
                onClick={() => selectExperience('focused')}
                className={`text-left rounded-xl border p-4 ${experience === 'focused' ? 'border-[#218380] bg-[#218380]/5' : 'border-black/10 bg-white/60'}`}
              >
                <Code2 className="w-5 h-5 text-[#218380] mb-2" />
                <div className="text-sm font-semibold text-[#303330]">Selected agents</div>
                <div className="text-xs text-[#636e72] mt-1">Share any agent type: Developer, Researcher, Assistant, or a custom agent.</div>
              </button>
              <button
                onClick={() => selectExperience('learning')}
                className={`text-left rounded-xl border p-4 ${experience === 'learning' ? 'border-[#8b6aae] bg-[#8b6aae]/5' : 'border-black/10 bg-white/60'}`}
              >
                <BookOpen className="w-5 h-5 text-[#8b6aae] mb-2" />
                <div className="text-sm font-semibold text-[#303330]">Learning companion</div>
                <div className="text-xs text-[#636e72] mt-1">One child-specific agent with learning context and progress reports.</div>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <label className="text-xs font-semibold text-[#636e72]">
                Person's name
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="e.g. Maya" className="mt-1 w-full rounded-lg border border-black/10 bg-white/70 px-3 py-2 text-sm text-[#303330] outline-none focus:border-[#218380]" />
              </label>
              <label className="text-xs font-semibold text-[#636e72]">
                Device name
                <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} placeholder="e.g. Maya's iPad" className="mt-1 w-full rounded-lg border border-black/10 bg-white/70 px-3 py-2 text-sm text-[#303330] outline-none focus:border-[#218380]" />
              </label>
            </div>

            <div className="mb-4">
              <div className="text-xs font-semibold text-[#636e72] mb-2">
                {experience === 'learning' ? 'Choose the dedicated learning agent' : 'Choose agents to share'}
              </div>
              <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                {agents.map((agent) => {
                  const selected = selectedAgentIds.includes(agent.id);
                  return (
                    <button key={agent.id} onClick={() => toggleAgent(agent.id)} className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left ${selected ? 'border-[#218380] bg-[#218380]/5' : 'border-black/10 bg-white/60'}`}>
                      <span className="text-lg">{agent.emoji || '◉'}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-[#303330] truncate">{agent.name}</span>
                        <span className="block text-xs text-[#7a8381] truncate">{agent.role}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="block text-xs font-semibold text-[#636e72] mb-4">
              {experience === 'learning' ? 'Learning context from a parent or guardian' : 'Context for this shared experience'}
              <textarea
                value={profileContext}
                onChange={(event) => setProfileContext(event.target.value)}
                rows={3}
                placeholder={experience === 'learning' ? 'Grade, current goals, interests, material being studied, and anything the agent should adapt to.' : 'Only information this companion’s assigned agents should know.'}
                className="mt-1 w-full rounded-lg border border-black/10 bg-white/70 px-3 py-2 text-sm text-[#303330] outline-none resize-y focus:border-[#218380]"
              />
            </label>

            <button onClick={createPairing} disabled={loading} className="w-full rounded-xl bg-[#218380] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
              {loading ? 'Saving secure share…' : editingDeviceId ? 'Update share' : 'Create share QR'}
            </button>
            {error && <div role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          </div>

          {pairingData && (
            <div className="mt-6 rounded-2xl border border-[#218380]/20 bg-[#218380]/5 p-5">
              <div className="flex flex-col items-center">
                <div className="bg-white p-3 rounded-xl shadow-lg mb-4">
                  <QRCodeSVG value={JSON.stringify(pairingData)} size={190} level="H" includeMargin />
                </div>
                <div className="text-sm font-semibold text-[#303330]">Scan with Canopy Mobile</div>
                <div className="text-xs text-[#636e72] text-center mt-2">
                  {pairingData.profile.displayName} will see only {pairingData.allowedAgentIds.length === 1 ? 'the selected agent' : `${pairingData.allowedAgentIds.length} selected agents`}.
                </div>
                <div className="mt-4 text-[11px] text-[#7a8381]">This share remains valid until you revoke it.</div>
              </div>
            </div>
          )}
        </div>

        {activeAssignments.length > 0 && (
          <div className="border-t border-black/10 bg-[#f3f1ec] px-6 py-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-[#7a8381] mb-3">Active shares</div>
            <div className="space-y-2">
              {activeAssignments.map((assignment) => {
                const shareableApps = assignment.grant.allowedAgentIds.flatMap((agentId) => {
                  const agent = agents.find((candidate) => candidate.id === agentId);
                  return (agent?.miniApps ?? []).map((app) => ({ agentId, agentName: agent?.name ?? agentId, app }));
                });
                return (
                <div key={assignment.grant.deviceId} className="rounded-lg border border-black/10 bg-[#faf9f6] px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[#303330]">{assignment.profile.displayName} · {assignment.grant.deviceName}</div>
                      <div className="text-xs text-[#7a8381] mt-1">{assignment.grant.experience === 'learning' ? 'Learning companion' : 'Selected agents'} · {assignment.grant.allowedAgentIds.length} agent{assignment.grant.allowedAgentIds.length === 1 ? '' : 's'}</div>
                    </div>
                    {assignment.grant.experience === 'learning' && (
                      <button onClick={() => generateReport(assignment)} disabled={reportLoadingFor === assignment.grant.deviceId} className="rounded-lg border border-[#8b6aae]/30 bg-[#8b6aae]/5 px-3 py-1.5 text-xs font-semibold text-[#755794]">
                        {reportLoadingFor === assignment.grant.deviceId ? 'Generating…' : 'Progress report'}
                      </button>
                    )}
                    <button onClick={() => editAssignment(assignment)} className="rounded-lg border border-black/10 bg-white/60 px-3 py-1.5 text-xs font-semibold text-[#303330]">Edit</button>
                    <button onClick={() => revoke(assignment.grant.deviceId)} className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700">Revoke</button>
                  </div>
                  {shareableApps.length > 0 && (
                    <div className="mt-3 border-t border-black/10 pt-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8381] mb-2">Saved mini-apps</div>
                      <div className="flex flex-wrap gap-2">
                        {shareableApps.map(({ agentId, agentName, app }) => {
                          const activeVersion = app.versions?.find((version) => version.id === app.activeVersionId) ?? app.versions?.[0];
                          if (!activeVersion) return null;
                          const key = `${assignment.profile.id}:${agentId}:${app.id}:${activeVersion.id}`;
                          const isPublishing = publishingAppKey === key;
                          const isPublished = publishedAppKeys.has(key);
                          return (
                            <button
                              key={key}
                              onClick={() => publishMiniApp(assignment, agentId, app)}
                              disabled={isPublishing}
                              title={`Publish ${app.name} from ${agentName} to ${assignment.profile.displayName}`}
                              className="rounded-lg border border-[#218380]/25 bg-[#218380]/5 px-3 py-1.5 text-xs font-semibold text-[#218380] disabled:opacity-50"
                            >
                              {isPublishing ? 'Publishing…' : isPublished ? `✓ ${app.name}` : `Publish ${app.name}`}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-2 text-[10px] text-[#7a8381]">Self-contained HTML is sandboxed on the device; external network and file access stay blocked.</div>
                    </div>
                  )}
                </div>
              )})}
            </div>
            {report && (
              <div className="mt-4 rounded-xl border border-[#8b6aae]/20 bg-[#8b6aae]/5 p-4">
                <div className="text-sm font-semibold text-[#755794] mb-2">Latest progress report</div>
                <div className="text-sm text-[#303330] leading-relaxed">{report.reportJson.summary}</div>
                {report.reportJson.strengths && report.reportJson.strengths.length > 0 && <div className="mt-3 text-xs text-[#636e72]"><strong className="text-[#303330]">Strengths:</strong> {report.reportJson.strengths.join(' · ')}</div>}
                {report.reportJson.needsPractice && report.reportJson.needsPractice.length > 0 && <div className="mt-2 text-xs text-[#636e72]"><strong className="text-[#303330]">Keep working on:</strong> {report.reportJson.needsPractice.join(' · ')}</div>}
                {report.reportJson.recommendedNext && report.reportJson.recommendedNext.length > 0 && <div className="mt-2 text-xs text-[#636e72]"><strong className="text-[#303330]">Next:</strong> {report.reportJson.recommendedNext.join(' · ')}</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
