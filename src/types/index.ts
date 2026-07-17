// Agent types
export type AgentStatus = 'active' | 'sleeping' | 'thinking' | 'stopped' | 'error';

export interface AgentPersonality {
  name: string;
  communication_style: string;
  expertise: string[];
  guardrails: string[];
  custom_instructions: string;
}

export interface AgentStats {
  tasks_today: number;
  messages_handled: number;
  uptime_seconds: number;
  total_cost_usd: number;
  custom_metrics?: {
    label: string;
    value: string | number;
  }[];
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  emoji: string;
  color: string;
  status: AgentStatus;
  isolated: boolean;
  container_id: string | null;
  personality: AgentPersonality;
  integrations: string[];
  created_at: string;
  stats: AgentStats;
}

// Bridge types
export type BridgeType =
  | 'imessage'
  | 'calendar'
  | 'files'
  | 'gmail'
  | 'slack'
  | 'website'
  | 'custom';

export interface BridgePermissions {
  read: boolean;
  write: boolean;
  delete: boolean;
}

export interface BridgeConfig {
  scope: Record<string, any>;
  expires_at?: string;
  push_enabled: boolean;
}

export interface Bridge {
  id: string;
  name: string;
  bridge_type: BridgeType;
  enabled: boolean;
  agent_id: string;
  config: BridgeConfig;
  permissions: BridgePermissions;
}

// Payment types
export interface PurchaseRequest {
  agent_id: string;
  description: string;
  merchant: string;
  amount_cents: number;
  category: string;
  is_recurring?: boolean;
}

export interface AgentBudget {
  agent_id: string;
  payments_enabled: boolean;
  auto_approve_threshold_cents: number;
  per_transaction_limit_cents: number;
  daily_limit_cents: number;
  monthly_limit_cents: number;
  hourly_velocity_limit: number;
  allowed_categories: string[];
  allowed_merchants: string[];
  blocked_merchants: string[];
  daily_spent_cents: number;
  monthly_spent_cents: number;
  require_approval_new_merchant: boolean;
  require_approval_recurring: boolean;
}

export interface PurchaseDecisionApproved {
  Approved?: null;
}

export interface PurchaseDecisionRequiresApproval {
  requires_user_approval?: {
    reason: string;
    flags?: string[];
    approval_id?: string | null;
  };
  RequiresUserApproval?: {
    reason: string;
    flags?: string[];
    approval_id?: string | null;
  };
}

export interface PurchaseDecisionDenied {
  denied?: {
    reasons: string[];
    flags?: string[];
  };
  Denied?: {
    reasons: string[];
    flags?: string[];
  };
}

export type PurchaseDecision =
  | 'approved'
  | 'denied'
  | PurchaseDecisionApproved
  | PurchaseDecisionRequiresApproval
  | PurchaseDecisionDenied;

export interface PurchaseRecord {
  id: string;
  agent_id: string;
  description: string;
  merchant: string;
  amount_cents: number;
  category: string;
  decision: PurchaseDecision;
  virtual_card_id?: string | null;
  timestamp: string;
}

export type PurchaseApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PurchaseApprovalRequest {
  id: string;
  agent_id: string;
  purchase_record_id: string;
  purchase_request: PurchaseRequest;
  reason: string;
  flags: string[];
  status: PurchaseApprovalStatus;
  created_at: string;
  resolved_at?: string | null;
  expires_at?: string | null;
}

export type VirtualCardProviderKind = 'mock' | 'privacy' | 'lithic_sandbox';
export type VirtualCardStatus = 'active' | 'consumed' | 'cancelled' | 'expired';

export interface VirtualCardRecord {
  id: string;
  agent_id: string;
  purchase_record_id: string;
  provider: VirtualCardProviderKind;
  provider_card_ref: string;
  last_four: string;
  amount_cents: number;
  merchant: string;
  memo: string;
  status: VirtualCardStatus;
  created_at: string;
  expires_at?: string | null;
}

export interface PurchaseExecutionResult {
  agent_id: string;
  decision: PurchaseDecision;
  purchase_record: PurchaseRecord;
  approval_request?: PurchaseApprovalRequest | null;
  virtual_card?: VirtualCardRecord | null;
  message?: string | null;
}

export interface PaymentDashboard {
  agent_id: string;
  budget: AgentBudget;
  pending_approvals: PurchaseApprovalRequest[];
  recent_purchases: PurchaseRecord[];
  active_virtual_cards: VirtualCardRecord[];
}
