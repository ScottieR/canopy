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
}

export interface AgentBudget {
  agent_id: string;
  payments_enabled: boolean;
  auto_approve_threshold_cents: number;
  per_transaction_limit_cents: number;
  daily_limit_cents: number;
  monthly_limit_cents: number;
  allowed_categories: string[];
  daily_spent_cents: number;
  monthly_spent_cents: number;
  require_approval_new_merchant: boolean;
  require_approval_recurring: boolean;
}

export type PurchaseDecision =
  | { type: 'approved' }
  | { type: 'requires_user_approval'; reason: string }
  | { type: 'denied'; reasons: string[] };
