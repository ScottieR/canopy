import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorldStore } from "../../store/worldStore";

type PaymentDashboard = {
  budget: {
    payments_enabled: boolean;
    monthly_spent_cents: number;
    monthly_limit_cents: number;
  };
  pending_approvals: Array<unknown>;
  active_virtual_cards: Array<unknown>;
};

export function PaymentSummary() {
  const agents = useWorldStore((state) => state.agents);
  const [totalSpent, setTotalSpent] = useState(0);
  const [budgetLimit, setBudgetLimit] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [activeCards, setActiveCards] = useState(0);
  const [enabledAgents, setEnabledAgents] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (agents.length === 0) {
      setTotalSpent(0);
      setBudgetLimit(0);
      setPendingApprovals(0);
      setActiveCards(0);
      setEnabledAgents(0);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const dashboards = await Promise.all(
        agents.map((agent) =>
          invoke<PaymentDashboard>("get_payment_dashboard", { agentId: agent.id }).catch(() => null),
        ),
      );

      const activeDashboards = dashboards.filter(
        (dashboard): dashboard is PaymentDashboard => !!dashboard && dashboard.budget?.payments_enabled,
      );

      setEnabledAgents(activeDashboards.length);
      setTotalSpent(
        activeDashboards.reduce(
          (sum, dashboard) => sum + (dashboard.budget.monthly_spent_cents || 0),
          0,
        ),
      );
      setBudgetLimit(
        activeDashboards.reduce(
          (sum, dashboard) => sum + (dashboard.budget.monthly_limit_cents || 0),
          0,
        ),
      );
      setPendingApprovals(
        activeDashboards.reduce(
          (sum, dashboard) => sum + (dashboard.pending_approvals?.length || 0),
          0,
        ),
      );
      setActiveCards(
        activeDashboards.reduce(
          (sum, dashboard) => sum + (dashboard.active_virtual_cards?.length || 0),
          0,
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [agents]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;

    listen("payment_state_changed", () => {
      if (mounted) {
        void load();
      }
    }).then((dispose) => {
      if (mounted) {
        unlisten = dispose;
      } else {
        dispose();
      }
    }).catch(() => {});

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [load]);

  const remaining = Math.max(0, budgetLimit - totalSpent);
  const percentage = budgetLimit > 0 ? (totalSpent / budgetLimit) * 100 : 0;

  return (
    <div className="bg-canopy-surface border border-canopy-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm">💳</span>
        <span className="text-[13px] font-semibold text-canopy-accent">Payments</span>
        <span className="text-[11px] text-canopy-sleeping ml-auto">This month</span>
      </div>
      {loading ? (
        <p className="text-[12px] text-canopy-text-muted/60">
          Loading payment budgets...
        </p>
      ) : budgetLimit === 0 ? (
        <p className="text-[12px] text-canopy-text-muted/60">
          No payment budgets configured yet. Enable payments on an agent to track spending.
        </p>
      ) : (
        <>
          <div className="flex gap-4 mb-3">
            <div>
              <div className="text-[22px] font-bold text-canopy-text">${(totalSpent / 100).toFixed(2)}</div>
              <div className="text-[10px] text-canopy-text-muted">Total spent</div>
            </div>
            <div className="border-l border-canopy-border pl-4">
              <div className="text-[22px] font-bold text-canopy-active">${(remaining / 100).toFixed(2)}</div>
              <div className="text-[10px] text-canopy-text-muted">Budget remaining</div>
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-canopy-text-muted mb-3">
            <span>{pendingApprovals} pending approvals</span>
            <span>{activeCards} active cards</span>
            <span>{enabledAgents} agents enabled</span>
          </div>
          <div className="h-1 bg-canopy-surface-hover rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(percentage, 100)}%`,
                background: percentage > 80
                  ? "linear-gradient(90deg, #FCD34D, #F59E0B)"
                  : "linear-gradient(90deg, #34D399, #6EE7B7)",
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
