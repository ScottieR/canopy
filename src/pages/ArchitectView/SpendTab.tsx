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
  }>;
};

type PurchaseDraft = {
  description: string;
  merchant: string;
  category: string;
  amount: string;
  isRecurring: boolean;
};

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
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [submitting, setSubmitting] = useState(false);
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
      const result: any = await invoke("get_payment_dashboard", { agentId: agent.id });
      setDashboard(result ?? null);
    } catch (e) {
      console.error("Failed to load payment dashboard", e);
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
      }
      await fetchDashboard();
    } catch (e) {
      console.error("Failed to submit test purchase", e);
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

  const { budget, pending_approvals, active_virtual_cards } = dashboard;
  const monthlyRemaining = Math.max(0, (budget.monthly_limit_cents || 0) - (budget.monthly_spent_cents || 0));

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

      {import.meta.env.DEV && (
        <div style={{ ...glass(0.5), borderRadius: 16, padding: 18, marginBottom: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>
            Dev Purchase Simulator
          </div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 16 }}>
            Use this with the mock provider or a configured sandbox provider to validate the full approval and issuance flow without real charges.
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
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#4A9E96", background: "#4A9E9615", padding: "4px 8px", borderRadius: 999 }}>
                  {String(card.status).toUpperCase()}
                </span>
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
