import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BookOpen, Code2, Smartphone, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { MiniApp, useWorldStore, reportTelemetryEvent } from '../../store/worldStore';

interface MobilePairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultAgentId?: string;
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
}) => {
  const agents = useWorldStore((state) => state.agents);
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

  useEffect(() => {
    if (!isOpen) return;
    setPairingData(null);
    setEditingDeviceId(null);
    setReport(null);
    setError(null);
    setSelectedAgentIds(defaultAgentId ? [defaultAgentId] : agents[0]?.id ? [agents[0].id] : []);
    refreshAssignments().catch((err) => setError(String(err)));
  }, [isOpen, defaultAgentId, agents]);

  const activeAssignments = useMemo(
    () => assignments.filter((assignment) => !assignment.grant.revoked),
    [assignments],
  );

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
      reportTelemetryEvent('companion_paired', { profileType, experience, deviceName: deviceName.trim() || 'iPad' });
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#111111] border border-white/10 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex justify-between items-center px-6 py-4 border-b border-white/10 bg-[#111111]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500/10 rounded-lg">
              <Smartphone className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white m-0">Share agents to a companion device</h2>
              <p className="text-xs text-zinc-500 m-0 mt-1">Every device receives only the agents explicitly selected here.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 grid gap-6 md:grid-cols-[1.2fr_0.8fr]">
          <div>
            <div className="grid grid-cols-2 gap-3 mb-5">
              <button
                onClick={() => selectExperience('focused')}
                className={`text-left rounded-xl border p-4 ${experience === 'focused' ? 'border-emerald-400 bg-emerald-500/10' : 'border-white/10 bg-white/5'}`}
              >
                <Code2 className="w-5 h-5 text-emerald-400 mb-2" />
                <div className="text-sm font-semibold text-white">Focused companion</div>
                <div className="text-xs text-zinc-400 mt-1">Share any agent type: Developer, Researcher, Assistant, or a custom agent.</div>
              </button>
              <button
                onClick={() => selectExperience('learning')}
                className={`text-left rounded-xl border p-4 ${experience === 'learning' ? 'border-violet-400 bg-violet-500/10' : 'border-white/10 bg-white/5'}`}
              >
                <BookOpen className="w-5 h-5 text-violet-400 mb-2" />
                <div className="text-sm font-semibold text-white">Learning companion</div>
                <div className="text-xs text-zinc-400 mt-1">One dedicated agent, child-scoped context, learning events, and progress reports.</div>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <label className="text-xs text-zinc-400">
                Companion name
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="e.g. Maya" className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none" />
              </label>
              <label className="text-xs text-zinc-400">
                Device name
                <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} placeholder="e.g. Maya's iPad" className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none" />
              </label>
            </div>

            <div className="mb-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
                {experience === 'learning' ? 'Choose the dedicated learning agent' : 'Choose agents to share'}
              </div>
              <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                {agents.map((agent) => {
                  const selected = selectedAgentIds.includes(agent.id);
                  return (
                    <button key={agent.id} onClick={() => toggleAgent(agent.id)} className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left ${selected ? 'border-emerald-400 bg-emerald-500/10' : 'border-white/10 bg-white/5'}`}>
                      <span className="text-lg">{agent.emoji || '◉'}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-white truncate">{agent.name}</span>
                        <span className="block text-xs text-zinc-500 truncate">{agent.role}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="block text-xs text-zinc-400 mb-4">
              {experience === 'learning' ? 'Parent-provided learning context' : 'Scoped companion context'}
              <textarea
                value={profileContext}
                onChange={(event) => setProfileContext(event.target.value)}
                rows={3}
                placeholder={experience === 'learning' ? 'Grade, current goals, interests, material being studied, and anything the agent should adapt to.' : 'Only information this companion’s assigned agents should know.'}
                className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none resize-y"
              />
            </label>

            <button onClick={createPairing} disabled={loading} className="w-full rounded-xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-black disabled:opacity-50">
              {loading ? 'Saving secure assignment…' : editingDeviceId ? 'Save and update the child app' : 'Create pairing QR'}
            </button>
            {error && <div className="mt-3 text-sm text-red-400">{error}</div>}
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            {!pairingData ? (
              <div className="h-full min-h-64 flex items-center justify-center text-center text-sm text-zinc-500">
                Configure the assignment, then generate a device-bound QR code.
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <div className="bg-white p-3 rounded-xl shadow-lg mb-4">
                  <QRCodeSVG value={JSON.stringify(pairingData)} size={190} level="H" includeMargin />
                </div>
                <div className="text-sm font-semibold text-white">Scan with Canopy Mobile</div>
                <div className="text-xs text-zinc-500 text-center mt-2">
                  {pairingData.profile.displayName} will see only {pairingData.allowedAgentIds.length === 1 ? 'the selected agent' : `${pairingData.allowedAgentIds.length} selected agents`}.
                </div>
                <div className="mt-4 text-[11px] text-zinc-500">This pairing remains valid until you revoke it.</div>
              </div>
            )}
          </div>
        </div>

        {activeAssignments.length > 0 && (
          <div className="border-t border-white/10 px-6 py-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-3">Active companion devices</div>
            <div className="space-y-2">
              {activeAssignments.map((assignment) => {
                const shareableApps = assignment.grant.allowedAgentIds.flatMap((agentId) => {
                  const agent = agents.find((candidate) => candidate.id === agentId);
                  return (agent?.miniApps ?? []).map((app) => ({ agentId, agentName: agent?.name ?? agentId, app }));
                });
                return (
                <div key={assignment.grant.deviceId} className="rounded-lg border border-white/10 bg-white/5 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white">{assignment.profile.displayName} · {assignment.grant.deviceName}</div>
                      <div className="text-xs text-zinc-500 mt-1">{assignment.grant.experience} · {assignment.grant.allowedAgentIds.length} agent{assignment.grant.allowedAgentIds.length === 1 ? '' : 's'}</div>
                    </div>
                    {assignment.grant.experience === 'learning' && (
                      <button onClick={() => generateReport(assignment)} disabled={reportLoadingFor === assignment.grant.deviceId} className="rounded-lg border border-violet-400/30 bg-violet-500/10 px-3 py-1.5 text-xs font-semibold text-violet-300">
                        {reportLoadingFor === assignment.grant.deviceId ? 'Generating…' : 'Progress report'}
                      </button>
                    )}
                    <button onClick={() => editAssignment(assignment)} className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-zinc-300">Edit</button>
                    <button onClick={() => revoke(assignment.grant.deviceId)} className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-300">Revoke</button>
                  </div>
                  {shareableApps.length > 0 && (
                    <div className="mt-3 border-t border-white/10 pt-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 mb-2">Saved mini-apps</div>
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
                              className="rounded-lg border border-cyan-400/25 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 disabled:opacity-50"
                            >
                              {isPublishing ? 'Publishing…' : isPublished ? `✓ ${app.name}` : `Publish ${app.name}`}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-2 text-[10px] text-zinc-600">Self-contained HTML is sandboxed on the device; external network and file access stay blocked.</div>
                    </div>
                  )}
                </div>
              )})}
            </div>
            {report && (
              <div className="mt-4 rounded-xl border border-violet-400/20 bg-violet-500/5 p-4">
                <div className="text-sm font-semibold text-violet-200 mb-2">Latest progress report</div>
                <div className="text-sm text-zinc-300 leading-relaxed">{report.reportJson.summary}</div>
                {report.reportJson.strengths && report.reportJson.strengths.length > 0 && <div className="mt-3 text-xs text-zinc-400"><strong className="text-zinc-300">Strengths:</strong> {report.reportJson.strengths.join(' · ')}</div>}
                {report.reportJson.needsPractice && report.reportJson.needsPractice.length > 0 && <div className="mt-2 text-xs text-zinc-400"><strong className="text-zinc-300">Keep working on:</strong> {report.reportJson.needsPractice.join(' · ')}</div>}
                {report.reportJson.recommendedNext && report.reportJson.recommendedNext.length > 0 && <div className="mt-2 text-xs text-zinc-400"><strong className="text-zinc-300">Next:</strong> {report.reportJson.recommendedNext.join(' · ')}</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
