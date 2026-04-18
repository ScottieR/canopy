import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export function PaymentSummary() {
  // TODO: Wire to real budget data from each agent
  const [totalSpent, setTotalSpent] = useState(0);
  const [budgetLimit, setBudgetLimit] = useState(0);

  const remaining = Math.max(0, budgetLimit - totalSpent);
  const percentage = budgetLimit > 0 ? (totalSpent / budgetLimit) * 100 : 0;

  return (
    <div className="bg-canopy-surface border border-canopy-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm">💳</span>
        <span className="text-[13px] font-semibold text-canopy-accent">Payments</span>
        <span className="text-[11px] text-canopy-sleeping ml-auto">This month</span>
      </div>
      {budgetLimit === 0 ? (
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
