import React, { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { AgentData } from "../../store/worldStore";
import { glass } from "../../App";

type PaymentDashboard = {
  agent_id: string;
  budget: {
    daily_spent_cents: number;
    monthly_spent_cents: number;
    monthly_limit_cents: number;
  };
  pending_approvals: Array<{
    id: string;
    purchase_request: {
      merchant: string;
      category: string;
        amount_cents: number;
    };
    reason: string;
    flags: string[];
    expires_at?: string | null;
  }>;
  recent_purchases: Array<{
    id: string;
    merchant: string;
    category: string;
    amount_cents: number;
    timestamp: string;
    decision: any;
  }>;
  active_virtual_cards: Array<{
    id: string;
    last_four: string;
    merchant: string;
    status: string;
    amount_cents: number;
    provider: string;
    provider_card_ref: string;
    expires_at?: string | null;
  }>;
  recent_transactions: Array<{
    id: string;
    merchant: string;
    amount_cents: number;
    status: string;
    source: string;
    decline_reason?: string | null;
    created_at: string;
  }>;
  recent_audit_entries?: Array<{
    id: string;
    event_type: string;
    detail_json?: Record<string, unknown>;
    created_at: string;
  }>;
};

type VirtualCardRecord = PaymentDashboard["active_virtual_cards"][number];

// One aggregated row from the internal metering ledger (token_usage_history),
// as returned by the get_agent_usage_totals command: totals for one
// (agent, model, provider) combination in the queried window.
type AgentUsageTotal = {
  agent_id: string;
  model: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  call_count: number;
};

type UsageWindowKey = "day" | "week" | "month";

const USAGE_WINDOWS: Array<{ key: UsageWindowKey; label: string; days: number }> = [
  { key: "day", label: "Today", days: 1 },
  { key: "week", label: "Last 7 days", days: 7 },
  { key: "month", label: "Last 30 days", days: 30 },
];

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function sumUsage(rows: AgentUsageTotal[] | null | undefined) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (acc, row) => ({
      cost: acc.cost + row.cost_usd,
      tokensIn: acc.tokensIn + row.tokens_in,
      tokensOut: acc.tokensOut + row.tokens_out,
      calls: acc.calls + row.call_count,
    }),
    { cost: 0, tokensIn: 0, tokensOut: 0, calls: 0 },
  );
}

/**
 * Per-agent LLM spend from the internal metering ledger. Populated by the app
 * itself on every model call, so it works with a single shared provider key —
 * no per-agent API keys required.
 */
function LlmUsageSection({ agentId }: { agentId: string }) {
  const [byWindow, setByWindow] = useState<Record<UsageWindowKey, AgentUsageTotal[]> | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<UsageWindowKey>("week");
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    Promise.all(
      USAGE_WINDOWS.map(w =>
        invoke<AgentUsageTotal[]>("get_agent_usage_totals", { agentId, days: w.days }),
      ),
    )
      .then(([day, week, month]) => {
        // Normalize here so a null/absent result can't reach the reducers.
        const rows = (value: unknown) => (Array.isArray(value) ? (value as AgentUsageTotal[]) : []);
        if (mounted) setByWindow({ day: rows(day), week: rows(week), month: rows(month) });
      })
      .catch(e => {
        console.error("Failed to load LLM usage totals", e);
        if (mounted) setError(true);
      });
    return () => {
      mounted = false;
    };
  }, [agentId]);

  const breakdown = byWindow?.[selectedWindow] ?? [];
  const selectedTotals = sumUsage(breakdown);

  return (
    <div style={{ ...glass(0.45), borderRadius: 16, padding: 18, marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)" }}>
          LLM Usage
        </div>
        <select
          value={selectedWindow}
          onChange={e => setSelectedWindow(e.target.value as UsageWindowKey)}
          style={{ ...fieldStyle, width: 160, cursor: "pointer" }}
        >
          {USAGE_WINDOWS.map(w => (
            <option key={w.key} value={w.key}>{w.label}</option>
          ))}
        </select>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 14 }}>
        Metered internally per model call — accurate even on a shared provider key.
      </div>

      {error ? (
        <div style={{ fontSize: 13, color: "var(--text-sub)" }}>Failed to load LLM usage.</div>
      ) : !byWindow ? (
        <div style={{ fontSize: 13, color: "var(--text-sub)" }}>Loading LLM usage...</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
            {USAGE_WINDOWS.map(w => {
              const totals = sumUsage(byWindow[w.key]);
              return (
                <div key={w.key} style={{ padding: 12, borderRadius: 12, background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.05)" }}>
                  <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 6 }}>{w.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-main)" }}>
                    ${totals.cost.toFixed(totals.cost >= 10 ? 2 : 3)}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 4 }}>
                    {formatTokens(totals.tokensIn)} in · {formatTokens(totals.tokensOut)} out · {totals.calls} calls
                  </div>
                </div>
              );
            })}
          </div>

          {breakdown.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text-sub)" }}>
              No metered model calls in this window yet.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--border-subtle)", textAlign: "left" }}>
                  <th style={headerStyle}>Model</th>
                  <th style={headerStyle}>Provider</th>
                  <th style={{ ...headerStyle, textAlign: "right" }}>Calls</th>
                  <th style={{ ...headerStyle, textAlign: "right" }}>Tokens In</th>
                  <th style={{ ...headerStyle, textAlign: "right" }}>Tokens Out</th>
                  <th style={{ ...headerStyle, textAlign: "right" }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map(row => (
                  <tr key={`${row.model}-${row.provider}`} style={{ borderTop: "1px solid rgba(0,0,0,0.04)" }}>
                    <td style={{ ...cellStyle, fontWeight: 700 }}>{row.model}</td>
                    <td style={{ ...cellStyle, color: "var(--text-sub)" }}>{row.provider}</td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>{row.call_count}</td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>{formatTokens(row.tokens_in)}</td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>{formatTokens(row.tokens_out)}</td>
                    <td style={{ ...cellStyle, textAlign: "right", fontWeight: 700 }}>${row.cost_usd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 10 }}>
            Totals for {selectedTotals.calls} call{selectedTotals.calls === 1 ? "" : "s"} in the selected window.
          </div>
        </>
      )}
    </div>
  );
}

type PurchaseDraft = {
  description: string;
  merchant: string;
  category: string;
  amount: string;
  isRecurring: boolean;
};

function formatAuditEventLabel(eventType: string): string {
  return eventType
    .split("_")
    .filter(Boolean)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatAuditSummary(detailJson?: Record<string, unknown>): string {
  if (!detailJson) return "Recorded by the payment workflow.";

  const merchant = typeof detailJson.merchant === "string" ? detailJson.merchant : null;
  const amountCents = typeof detailJson.amountCents === "number" ? detailJson.amountCents : null;
  if (merchant && amountCents != null) {
    return `${merchant} · $${(amountCents / 100).toFixed(2)}`;
  }

  const cardId = typeof detailJson.cardId === "string" ? detailJson.cardId : null;
  if (cardId) {
    return `Card ${cardId.slice(0, 8)}…`;
  }

  const purchaseRecordId =
    typeof detailJson.purchaseRecordId === "string" ? detailJson.purchaseRecordId : null;
  if (purchaseRecordId) {
    return `Purchase ${purchaseRecordId.slice(0, 8)}…`;
  }

  const approvalId = typeof detailJson.approvalId === "string" ? detailJson.approvalId : null;
  if (approvalId) {
    return `Approval ${approvalId.slice(0, 8)}…`;
  }

  return "Recorded by the payment workflow.";
}

function formatProviderRef(providerRef: string): string {
  if (providerRef.length <= 16) {
    return providerRef;
  }

  return `${providerRef.slice(0, 8)}…${providerRef.slice(-6)}`;
}

function getDecisionStatus(decision: any): "approved" | "denied" | "requires_approval" {
  if (decision === "approved" || decision === "Approved" || decision?.Approved === null) {
    return "approved";
  }
  if (decision === "denied" || decision === "Denied" || decision?.Denied || decision?.denied) {
    return "denied";
  }
  return "requires_approval";
}

function SpendBadge({ status }: { status: "approved" | "denied" | "requires_approval" }) {
  const tone = status === "approved"
    ? { color: "#4A9E96", background: "#4A9E9615", label: "APPROVED" }
    : status === "denied"
      ? { color: "#E57373", background: "#E5737315", label: "DENIED" }
      : { color: "#D4A04A", background: "#D4A04A15", label: "AWAITING APPROVAL" };

  return (
    <span
      style={{
        color: tone.color,
        background: tone.background,
        padding: "4px 8px",
        borderRadius: 4,
        fontWeight: 600,
        fontSize: 11,
      }}
    >
      {tone.label}
    </span>
  );
}

export function SpendTab({ agent }: { agent: AgentData }) {
  const [dashboard, setDashboard] = useState<PaymentDashboard | null>(null);
  const [allCards, setAllCards] = useState<VirtualCardRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [submitting, setSubmitting] = useState(false);
  const [cardActionId, setCardActionId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string>("");
  const [purchaseDraft, setPurchaseDraft] = useState<PurchaseDraft>({
    description: "Test software purchase",
    merchant: "Amazon",
    category: "software",
    amount: "24",
    isRecurring: false,
  });

  const fetchDashboard = React.useCallback(async () => {
    setLoading(true);
    try {
      const [dashboardResult, cardsResult] = await Promise.all([
        invoke<any>("get_payment_dashboard", { agentId: agent.id }),
        invoke<any[]>("get_virtual_cards_for_agent", { agentId: agent.id, activeOnly: false }),
      ]);
      setDashboard(dashboardResult ?? null);
      setAllCards(Array.isArray(cardsResult) ? cardsResult : []);
      setFeedback("");
    } catch (e) {
      console.error("Failed to load payment dashboard", e);
      setFeedback("Failed to refresh payment data.");
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;

    listen<{ agent_id?: string }>("payment_state_changed", (event) => {
      if (!mounted) return;
      if (event.payload?.agent_id === agent.id) {
        fetchDashboard();
      }
    }).then(fn => {
      if (mounted) unlisten = fn;
    }).catch((e) => {
      console.warn("payment_state_changed listener setup failed", e);
    });

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [agent.id, fetchDashboard]);

  const filteredHistory = useMemo(() => {
    const purchases = dashboard?.recent_purchases ?? [];
    return purchases.filter(record => {
      const matchesSearch =
        record.merchant?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        record.category?.toLowerCase().includes(searchQuery.toLowerCase());
      const status = getDecisionStatus(record.decision);
      const matchesStatus = statusFilter === "All"
        || (statusFilter === "Approved" && status === "approved")
        || (statusFilter === "Denied" && status === "denied")
        || (statusFilter === "Awaiting Approval" && status === "requires_approval");
      return matchesSearch && matchesStatus;
    });
  }, [dashboard?.recent_purchases, searchQuery, statusFilter]);

  const handleDraftChange = (key: keyof PurchaseDraft, value: string | boolean) => {
    setPurchaseDraft(current => ({ ...current, [key]: value }));
  };

  const cancelCard = async (cardId: string) => {
    setCardActionId(cardId);
    setFeedback("");
    try {
      await invoke("cancel_virtual_card", { cardId });
      setFeedback("Virtual card cancelled.");
      await fetchDashboard();
    } catch (e) {
      console.error("Failed to cancel virtual card", e);
      setFeedback("Failed to cancel virtual card.");
    } finally {
      setCardActionId(null);
    }
  };

  const simulateCardCharge = async (cardId: string) => {
    setCardActionId(cardId);
    setFeedback("");
    try {
      await invoke("simulate_virtual_card_charge", { cardId });
      setFeedback("Mock card charge simulated.");
      await fetchDashboard();
    } catch (e) {
      console.error("Failed to simulate virtual card charge", e);
      setFeedback("Failed to simulate virtual card charge.");
    } finally {
      setCardActionId(null);
    }
  };

  const simulateCardDecline = async (cardId: string) => {
    setCardActionId(cardId);
    setFeedback("");
    try {
      await invoke("simulate_virtual_card_decline", { cardId });
      setFeedback("Mock card decline simulated and spend reconciled.");
      await fetchDashboard();
    } catch (e) {
      console.error("Failed to simulate virtual card decline", e);
      setFeedback("Failed to simulate virtual card decline.");
    } finally {
      setCardActionId(null);
    }
  };

  const simulateProviderEvent = async (
    cardId: string,
    outcome: "captured" | "declined",
  ) => {
    setCardActionId(cardId);
    setFeedback("");
    try {
      await invoke("simulate_provider_transaction_event", { cardId, outcome });
      setFeedback(
        outcome === "captured"
          ? "Provider-style capture event injected."
          : "Provider-style decline event injected and reconciled.",
      );
      await fetchDashboard();
    } catch (e) {
      console.error("Failed to simulate provider transaction event", e);
      setFeedback("Failed to simulate provider transaction event.");
    } finally {
      setCardActionId(null);
    }
  };

  const copyProviderRef = async (providerCardRef: string) => {
    setFeedback("");
    try {
      if (!navigator.clipboard?.writeText) {
        setFeedback("Clipboard copy is unavailable in this environment.");
        return;
      }

      await navigator.clipboard.writeText(providerCardRef);
      setFeedback("Provider reference copied for sandbox testing.");
    } catch (e) {
      console.error("Failed to copy provider card reference", e);
      setFeedback("Failed to copy provider reference.");
    }
  };

  const submitTestPurchase = async () => {
    setSubmitting(true);
    try {
      const amountCents = Math.max(0, Math.round((Number(purchaseDraft.amount) || 0) * 100));
      const result: any = await invoke("request_purchase", {
        request: {
          agent_id: agent.id,
          description: purchaseDraft.description,
          merchant: purchaseDraft.merchant,
          category: purchaseDraft.category,
          amount_cents: amountCents,
          is_recurring: purchaseDraft.isRecurring,
        },
      });
      if (result?.message) {
        console.info("Payment request result:", result.message);
        setFeedback(String(result.message));
      }
      await fetchDashboard();
    } catch (e) {
      console.error("Failed to submit test purchase", e);
      setFeedback("Failed to submit purchase request.");
    } finally {
      setSubmitting(false);
    }
  };

  const issueDevelopmentProviderCard = async (provider: "privacy" | "lithic_sandbox") => {
    setSubmitting(true);
    setFeedback("");
    try {
      const amountCents = Math.max(0, Math.round((Number(purchaseDraft.amount) || 0) * 100));
      const result = await invoke<string>("issue_development_provider_card", {
        agentId: agent.id,
        amountCents,
        category: purchaseDraft.category,
        merchant: purchaseDraft.merchant,
        provider,
      });
      setFeedback(result || "Development provider card issued.");
      await fetchDashboard();
    } catch (e) {
      console.error("Failed to issue development provider card", e);
      setFeedback("Failed to issue development provider card.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div style={{ color: "var(--text-sub)", fontSize: 14 }}>Loading financial data...</div>;
  }

  if (!dashboard) {
    return <div style={{ color: "var(--text-sub)", fontSize: 14 }}>Failed to load payment dashboard.</div>;
  }

  const {
    budget,
    pending_approvals,
    active_virtual_cards,
    recent_transactions,
    recent_audit_entries = [],
  } = dashboard;
  const monthlyRemaining = Math.max(0, (budget.monthly_limit_cents || 0) - (budget.monthly_spent_cents || 0));
  const settledOrInactiveCards = allCards.filter(card => card.status !== "active");

  return (
    <div style={{ paddingBottom: 64 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0" }}>Spending</h1>
          <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0 }}>
            Review purchase requests, approvals, active virtual cards, and actual spend for {agent.name}.
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 20 }}>
        {[
          { label: "Daily spend", value: `$${(budget.daily_spent_cents / 100).toFixed(2)}` },
          { label: "Monthly spend", value: `$${(budget.monthly_spent_cents / 100).toFixed(2)}` },
          { label: "Remaining", value: `$${(monthlyRemaining / 100).toFixed(2)}` },
          { label: "Pending approvals", value: String(pending_approvals.length) },
        ].map(card => (
          <div key={card.label} style={{ ...glass(0.45), borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 8 }}>{card.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "var(--text-main)" }}>{card.value}</div>
          </div>
        ))}
      </div>

      <LlmUsageSection agentId={agent.id} />

      {feedback && (
        <div style={{ marginBottom: 16, fontSize: 12, color: "var(--text-sub)" }}>
          {feedback}
        </div>
      )}

      {import.meta.env.DEV && (
        <div style={{ ...glass(0.5), borderRadius: 16, padding: 18, marginBottom: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>
            Dev Purchase Simulator
          </div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 16 }}>
            Use this with the mock provider or a configured sandbox provider to validate the full approval and issuance flow without real charges.
          </div>
          <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 12 }}>
            Mock gives you a fully local fake-card loop. Privacy.com and Lithic Sandbox cards can also use the dev-only Inject Capture and Inject Decline controls below to exercise reconciliation without waiting on a real webhook.
          </div>
          <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 12 }}>
            Need provider-specific testing without live issuance? Use the synthetic provider buttons below to create a local Privacy or Lithic-style card, then replay events with Inject Capture, Inject Decline, or the signed webhook smoke helper.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 0.8fr", gap: 10, marginBottom: 10 }}>
            <input value={purchaseDraft.description} onChange={e => handleDraftChange("description", e.target.value)} placeholder="Description" style={fieldStyle} />
            <input value={purchaseDraft.merchant} onChange={e => handleDraftChange("merchant", e.target.value)} placeholder="Merchant" style={fieldStyle} />
            <input value={purchaseDraft.category} onChange={e => handleDraftChange("category", e.target.value)} placeholder="Category" style={fieldStyle} />
            <input value={purchaseDraft.amount} onChange={e => handleDraftChange("amount", e.target.value)} placeholder="Amount" type="number" min="0" step="0.01" style={fieldStyle} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-main)" }}>
              <input
                type="checkbox"
                checked={purchaseDraft.isRecurring}
                onChange={e => handleDraftChange("isRecurring", e.target.checked)}
              />
              Mark as recurring
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button
                onClick={() => issueDevelopmentProviderCard("privacy")}
                disabled={submitting}
                style={devSecondaryButtonStyle(submitting)}
              >
                {submitting ? "Working..." : "Create Privacy Test Card"}
              </button>
              <button
                onClick={() => issueDevelopmentProviderCard("lithic_sandbox")}
                disabled={submitting}
                style={devSecondaryButtonStyle(submitting)}
              >
                {submitting ? "Working..." : "Create Lithic Test Card"}
              </button>
              <button
                onClick={submitTestPurchase}
                disabled={submitting}
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "none",
                  background: submitting ? "#4A9E96" : "#3c6663",
                  color: "var(--surface-card)",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: submitting ? "default" : "pointer",
                }}
              >
                {submitting ? "Submitting..." : "Request Purchase"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pending_approvals.length > 0 && (
        <div style={{ ...glass(0.45), borderRadius: 16, padding: 18, marginBottom: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)", marginBottom: 12 }}>
            Awaiting Approval
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            {pending_approvals.map(approval => (
              <div key={approval.id} style={{ padding: 14, borderRadius: 12, border: "1px solid rgba(0,0,0,0.06)", background: "rgba(0,0,0,0.02)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>
                      {approval.purchase_request.merchant} · ${(approval.purchase_request.amount_cents / 100).toFixed(2)}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 4 }}>
                      {approval.purchase_request.category} · {approval.reason}
                    </div>
                    {approval.expires_at && (
                      <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 6 }}>
                        Expires {new Date(approval.expires_at).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <SpendBadge status="requires_approval" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        <input
          type="text"
          placeholder="Search merchant or category..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{ ...fieldStyle, flex: 1 }}
        />
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          style={{ ...fieldStyle, width: 180, cursor: "pointer" }}
        >
          <option value="All">All Statuses</option>
          <option value="Approved">Approved</option>
          <option value="Denied">Denied</option>
          <option value="Awaiting Approval">Awaiting Approval</option>
        </select>
      </div>

      {filteredHistory.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--text-sub)", fontSize: 14, ...glass(0.4), borderRadius: 16 }}>
          {(dashboard.recent_purchases || []).length === 0 ? "There are no recent agent transactions on record." : "No transactions match your filters."}
        </div>
      ) : (
        <div style={{ ...glass(0.6), borderRadius: 16, overflow: "hidden", marginBottom: 20 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--border-subtle)", textAlign: "left" }}>
                <th style={headerStyle}>Date/Time</th>
                <th style={headerStyle}>Merchant</th>
                <th style={headerStyle}>Category</th>
                <th style={headerStyle}>Status</th>
                <th style={{ ...headerStyle, textAlign: "right" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {filteredHistory.map((record, index) => {
                const status = getDecisionStatus(record.decision);
                return (
                  <tr key={record.id || index} style={{ borderTop: "1px solid rgba(0,0,0,0.04)" }}>
                    <td style={cellStyle}>{new Date(record.timestamp || Date.now()).toLocaleString()}</td>
                    <td style={{ ...cellStyle, fontWeight: 700 }}>{record.merchant}</td>
                    <td style={{ ...cellStyle, color: "var(--text-sub)" }}>{record.category}</td>
                    <td style={cellStyle}><SpendBadge status={status} /></td>
                    <td style={{ ...cellStyle, textAlign: "right", fontWeight: 700 }}>${((record.amount_cents || 0) / 100).toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ ...glass(0.45), borderRadius: 16, padding: 18 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)", marginBottom: 12 }}>
          Active Virtual Cards
        </div>
        {active_virtual_cards.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-sub)" }}>No active virtual cards.</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {active_virtual_cards.map(card => (
              <div key={card.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, borderRadius: 12, background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.05)" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>
                    {card.merchant} · •••• {card.last_four}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 4 }}>
                    {card.provider} · ${(card.amount_cents / 100).toFixed(2)}
                  </div>
                  {import.meta.env.DEV && card.provider !== "mock" && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 11, color: "var(--text-sub)" }}>
                        Provider ref: <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "var(--text-main)" }}>{formatProviderRef(card.provider_card_ref)}</span>
                      </div>
                      <button
                        onClick={() => copyProviderRef(card.provider_card_ref)}
                        style={{
                          padding: "4px 8px",
                          borderRadius: 8,
                          border: "1px solid rgba(0,0,0,0.08)",
                          background: "var(--surface-card)",
                          color: "var(--text-main)",
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        Copy Provider Ref
                      </button>
                    </div>
                  )}
                  {card.expires_at && (
                    <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 4 }}>
                      Expires {new Date(card.expires_at).toLocaleString()}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#4A9E96", background: "#4A9E9615", padding: "4px 8px", borderRadius: 999 }}>
                    {String(card.status).toUpperCase()}
                  </span>
                  {card.provider === "mock" && (
                    <>
                      <button
                        onClick={() => simulateCardCharge(card.id)}
                        disabled={cardActionId === card.id}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid rgba(0,0,0,0.08)",
                          background: "var(--surface-card)",
                          color: "var(--text-main)",
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: cardActionId === card.id ? "default" : "pointer",
                        }}
                      >
                        {cardActionId === card.id ? "Simulating..." : "Simulate Use"}
                      </button>
                      <button
                        onClick={() => simulateCardDecline(card.id)}
                        disabled={cardActionId === card.id}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid rgba(0,0,0,0.08)",
                          background: "var(--surface-card)",
                          color: "#92400e",
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: cardActionId === card.id ? "default" : "pointer",
                        }}
                      >
                        {cardActionId === card.id ? "Simulating..." : "Simulate Decline"}
                      </button>
                    </>
                  )}
                  {import.meta.env.DEV && card.provider !== "mock" && (
                    <>
                      <button
                        onClick={() => simulateProviderEvent(card.id, "captured")}
                        disabled={cardActionId === card.id}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid rgba(0,0,0,0.08)",
                          background: "var(--surface-card)",
                          color: "var(--text-main)",
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: cardActionId === card.id ? "default" : "pointer",
                        }}
                      >
                        {cardActionId === card.id ? "Injecting..." : "Inject Capture"}
                      </button>
                      <button
                        onClick={() => simulateProviderEvent(card.id, "declined")}
                        disabled={cardActionId === card.id}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid rgba(0,0,0,0.08)",
                          background: "var(--surface-card)",
                          color: "#92400e",
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: cardActionId === card.id ? "default" : "pointer",
                        }}
                      >
                        {cardActionId === card.id ? "Injecting..." : "Inject Decline"}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => cancelCard(card.id)}
                    disabled={cardActionId === card.id}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 8,
                      border: "1px solid rgba(0,0,0,0.08)",
                      background: "var(--surface-card)",
                      color: "var(--text-main)",
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: cardActionId === card.id ? "default" : "pointer",
                    }}
                  >
                    {cardActionId === card.id ? "Cancelling..." : "Cancel Card"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ ...glass(0.45), borderRadius: 16, padding: 18, marginTop: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)", marginBottom: 12 }}>
          Card Activity
        </div>
        {settledOrInactiveCards.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-sub)" }}>
            No inactive or consumed cards yet.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {settledOrInactiveCards.map(card => (
              <div key={card.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, borderRadius: 12, background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.05)" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>
                    {card.merchant} · •••• {card.last_four}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 4 }}>
                    {card.provider} · ${(card.amount_cents / 100).toFixed(2)}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-main)", background: "rgba(0,0,0,0.06)", padding: "4px 8px", borderRadius: 999 }}>
                  {String(card.status).toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ ...glass(0.45), borderRadius: 16, padding: 18, marginTop: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)", marginBottom: 12 }}>
          Transaction Activity
        </div>
        {recent_transactions.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-sub)" }}>
            No settled or declined transactions recorded yet.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {recent_transactions.map(transaction => (
              <div key={transaction.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, borderRadius: 12, background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.05)" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>
                    {transaction.merchant} · ${(transaction.amount_cents / 100).toFixed(2)}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 4 }}>
                    {transaction.source} · {new Date(transaction.created_at).toLocaleString()}
                  </div>
                  {transaction.decline_reason && (
                    <div style={{ fontSize: 11, color: "#92400e", marginTop: 4 }}>
                      {transaction.decline_reason}
                    </div>
                  )}
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-main)", background: "rgba(0,0,0,0.06)", padding: "4px 8px", borderRadius: 999 }}>
                  {String(transaction.status).toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ ...glass(0.45), borderRadius: 16, padding: 18, marginTop: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)", marginBottom: 12 }}>
          Audit Trail
        </div>
        {recent_audit_entries.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-sub)" }}>
            No payment audit entries recorded yet.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {recent_audit_entries.map(entry => (
              <div key={entry.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, borderRadius: 12, background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.05)" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>
                    {formatAuditEventLabel(entry.event_type)}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 4 }}>
                    {formatAuditSummary(entry.detail_json)}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 4 }}>
                    {new Date(entry.created_at).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--border-subtle)",
  background: "var(--surface-card)",
  fontSize: 13,
  outline: "none",
  color: "var(--text-main)",
};

const headerStyle: React.CSSProperties = {
  padding: "12px 20px",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-sub)",
};

const cellStyle: React.CSSProperties = {
  padding: "14px 20px",
  fontSize: 13,
  color: "var(--text-main)",
};

function devSecondaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid rgba(0,0,0,0.08)",
    background: "var(--surface-card)",
    color: "var(--text-main)",
    fontSize: 12,
    fontWeight: 700,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.7 : 1,
  };
}
