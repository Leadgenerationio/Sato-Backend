import type { AuthPayload } from '../types/index.js';

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  type: 'scheduled' | 'trigger' | 'manual';
  schedule: string | null;
  status: 'active' | 'paused' | 'draft';
  lastRunAt: string | null;
  nextRunAt: string | null;
  totalRuns: number;
  successRate: number;
}

export interface WorkflowStep {
  id: string;
  order: number;
  name: string;
  type: string;
  config: string;
  status: 'pending' | 'completed' | 'failed' | 'skipped';
}

export interface WorkflowExecution {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'paused';
  stepsCompleted: number;
  stepsTotal: number;
  result: string | null;
}

export interface WorkflowDetail extends WorkflowSummary {
  steps: WorkflowStep[];
  recentExecutions: WorkflowExecution[];
}

const MOCK_WORKFLOWS: WorkflowDetail[] = [
  {
    id: 'wf-1',
    name: 'Weekly Auto-Invoice',
    description: 'Every Monday 9 AM — pull 7-day LeadByte data, calculate totals, create Xero invoice, send to client, notify May.',
    type: 'scheduled',
    schedule: 'Every Monday 9:00 AM',
    status: 'active',
    lastRunAt: '2026-04-14T09:00:00Z',
    nextRunAt: '2026-04-21T09:00:00Z',
    totalRuns: 28,
    successRate: 96.4,
    steps: [
      { id: 'ws-1', order: 1, name: 'Pull LeadByte Data', type: 'api_call', config: 'Fetch 7-day lead delivery data for all weekly_auto clients', status: 'completed' },
      { id: 'ws-2', order: 2, name: 'Calculate Invoice Totals', type: 'computation', config: 'Sum valid leads × lead price per client, apply VAT if registered', status: 'completed' },
      { id: 'ws-3', order: 3, name: 'Create Xero Invoice', type: 'api_call', config: 'Push invoice to Xero with line items per campaign', status: 'completed' },
      { id: 'ws-4', order: 4, name: 'Send Invoice Email', type: 'api_call', config: 'Send via Xero email to client billing contact', status: 'completed' },
      { id: 'ws-5', order: 5, name: 'Notify Finance Team', type: 'notification', config: 'Email May with summary of invoices created', status: 'completed' },
    ],
    recentExecutions: [
      { id: 'we-1', startedAt: '2026-04-14T09:00:00Z', completedAt: '2026-04-14T09:02:15Z', status: 'completed', stepsCompleted: 5, stepsTotal: 5, result: '3 invoices created, total £8,420.00' },
      { id: 'we-2', startedAt: '2026-04-07T09:00:00Z', completedAt: '2026-04-07T09:01:58Z', status: 'completed', stepsCompleted: 5, stepsTotal: 5, result: '3 invoices created, total £7,890.00' },
      { id: 'we-3', startedAt: '2026-03-31T09:00:00Z', completedAt: '2026-03-31T09:03:10Z', status: 'failed', stepsCompleted: 3, stepsTotal: 5, result: 'Xero API timeout — retried manually' },
      { id: 'we-4', startedAt: '2026-03-24T09:00:00Z', completedAt: '2026-03-24T09:01:45Z', status: 'completed', stepsCompleted: 5, stepsTotal: 5, result: '4 invoices created, total £11,200.00' },
      { id: 'we-5', startedAt: '2026-03-17T09:00:00Z', completedAt: '2026-03-17T09:02:00Z', status: 'completed', stepsCompleted: 5, stepsTotal: 5, result: '3 invoices created, total £9,150.00' },
    ],
  },
  {
    id: 'wf-2',
    name: 'Monthly Validated Invoice',
    description: '1st of each month — export lead data, send to client for validation, wait for approval, create amended Xero invoice.',
    type: 'scheduled',
    schedule: '1st of month 9:00 AM',
    status: 'active',
    lastRunAt: '2026-04-01T09:00:00Z',
    nextRunAt: '2026-05-01T09:00:00Z',
    totalRuns: 6,
    successRate: 100,
    steps: [
      { id: 'ws-6', order: 1, name: 'Export Monthly Lead Data', type: 'api_call', config: 'Pull full month LeadByte data for monthly_validated clients', status: 'completed' },
      { id: 'ws-7', order: 2, name: 'Generate Validation Report', type: 'computation', config: 'Create CSV/PDF with daily lead breakdown per campaign', status: 'completed' },
      { id: 'ws-8', order: 3, name: 'Send to Client for Approval', type: 'notification', config: 'Email validation report to client, wait for sign-off', status: 'completed' },
      { id: 'ws-9', order: 4, name: 'Wait for Client Approval', type: 'approval', config: 'Pause until client confirms or requests amendments', status: 'completed' },
      { id: 'ws-10', order: 5, name: 'Create Xero Invoice', type: 'api_call', config: 'Create invoice with approved/amended amounts', status: 'completed' },
      { id: 'ws-11', order: 6, name: 'Send Invoice', type: 'api_call', config: 'Send via Xero email', status: 'completed' },
    ],
    recentExecutions: [
      { id: 'we-6', startedAt: '2026-04-01T09:00:00Z', completedAt: '2026-04-03T14:20:00Z', status: 'completed', stepsCompleted: 6, stepsTotal: 6, result: '2 invoices created after client approval, total £6,800.00' },
      { id: 'we-7', startedAt: '2026-03-01T09:00:00Z', completedAt: '2026-03-04T10:15:00Z', status: 'completed', stepsCompleted: 6, stepsTotal: 6, result: '2 invoices created, 1 amended, total £5,950.00' },
    ],
  },
  {
    id: 'wf-3',
    name: 'Invoice Chasing',
    description: 'Daily 9 AM — check overdue invoices, send graduated chase emails, escalate after thresholds, detect deteriorating payment patterns.',
    type: 'scheduled',
    schedule: 'Daily 9:00 AM',
    status: 'active',
    lastRunAt: '2026-04-16T09:00:00Z',
    nextRunAt: '2026-04-17T09:00:00Z',
    totalRuns: 180,
    successRate: 100,
    steps: [
      { id: 'ws-12', order: 1, name: 'Check Overdue Invoices', type: 'query', config: 'Find all invoices past due date', status: 'completed' },
      { id: 'ws-13', order: 2, name: 'Classify by Severity', type: 'computation', config: '1-3d: gentle reminder, 7d: firm follow-up, 14d: escalation, 30d: final notice', status: 'completed' },
      { id: 'ws-14', order: 3, name: 'Send Chase Emails', type: 'notification', config: 'Send appropriate chase template per severity level', status: 'completed' },
      { id: 'ws-15', order: 4, name: 'Log Chase History', type: 'database', config: 'Record chase attempt in chase_history table', status: 'completed' },
      { id: 'ws-16', order: 5, name: 'Detect Payment Patterns', type: 'computation', config: 'Flag clients with 3+ late payments in 90 days', status: 'completed' },
      { id: 'ws-17', order: 6, name: 'Escalation Alerts', type: 'notification', config: 'Notify owner if client flagged for deteriorating payments', status: 'completed' },
    ],
    recentExecutions: [
      { id: 'we-8', startedAt: '2026-04-16T09:00:00Z', completedAt: '2026-04-16T09:00:45Z', status: 'completed', stepsCompleted: 6, stepsTotal: 6, result: '4 overdue invoices chased, 1 escalation sent' },
      { id: 'we-9', startedAt: '2026-04-15T09:00:00Z', completedAt: '2026-04-15T09:00:38Z', status: 'completed', stepsCompleted: 6, stepsTotal: 6, result: '3 overdue invoices chased, 0 escalations' },
      { id: 'we-10', startedAt: '2026-04-14T09:00:00Z', completedAt: '2026-04-14T09:00:42Z', status: 'completed', stepsCompleted: 6, stepsTotal: 6, result: '5 overdue invoices chased, 2 escalations sent' },
    ],
  },
];

const STEP_TYPES = ['data_fetch', 'calculation', 'approval', 'action', 'notification', 'wait', 'api_call', 'query', 'computation', 'database'];

export interface ScheduleConfig {
  frequency: 'daily' | 'weekly' | 'monthly';
  day?: string;
  time: string;
}

function buildScheduleString(config: ScheduleConfig): string {
  const [hours, minutes] = config.time.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 || 12;
  const timeStr = `${h12}:${String(minutes).padStart(2, '0')} ${period}`;

  if (config.frequency === 'daily') return `Daily ${timeStr}`;
  if (config.frequency === 'weekly') return `Every ${config.day || 'Monday'} ${timeStr}`;
  if (config.frequency === 'monthly') {
    const d = config.day || '1';
    const suffix = d === '1' ? 'st' : d === '2' ? 'nd' : d === '3' ? 'rd' : 'th';
    return `${d}${suffix} of month ${timeStr}`;
  }
  return config.time;
}

let nextWfId = 4;
let nextStepId = 20;
let nextExecId = 20;

export async function listWorkflows(_requester: AuthPayload): Promise<WorkflowSummary[]> {
  return MOCK_WORKFLOWS.map(({ steps, recentExecutions, ...summary }) => summary);
}

export async function getWorkflow(id: string, _requester: AuthPayload): Promise<WorkflowDetail | null> {
  return MOCK_WORKFLOWS.find((w) => w.id === id) ?? null;
}

export async function createWorkflow(
  data: { name: string; description: string; type: WorkflowSummary['type']; schedule?: string | null; scheduleConfig?: ScheduleConfig; steps: { name: string; type: string; config: string }[] },
  _requester: AuthPayload,
): Promise<WorkflowDetail> {
  const schedule = data.scheduleConfig
    ? buildScheduleString(data.scheduleConfig)
    : data.schedule ?? null;

  const wf: WorkflowDetail = {
    id: `wf-${nextWfId++}`,
    name: data.name,
    description: data.description,
    type: data.type,
    schedule,
    status: 'draft',
    lastRunAt: null,
    nextRunAt: null,
    totalRuns: 0,
    successRate: 0,
    steps: data.steps.map((s, i) => ({
      id: `ws-${nextStepId++}`,
      order: i + 1,
      name: s.name,
      type: s.type,
      config: s.config,
      status: 'pending' as const,
    })),
    recentExecutions: [],
  };
  MOCK_WORKFLOWS.push(wf);
  return wf;
}

export async function updateWorkflow(
  id: string,
  data: Partial<{ name: string; description: string; schedule: string | null; scheduleConfig: ScheduleConfig; steps: { name: string; type: string; config: string }[] }>,
  _requester: AuthPayload,
): Promise<WorkflowDetail | null> {
  const wf = MOCK_WORKFLOWS.find((w) => w.id === id);
  if (!wf) return null;

  if (data.name) wf.name = data.name;
  if (data.description) wf.description = data.description;
  if (data.scheduleConfig) wf.schedule = buildScheduleString(data.scheduleConfig);
  else if (data.schedule !== undefined) wf.schedule = data.schedule;
  if (data.steps) {
    wf.steps = data.steps.map((s, i) => ({
      id: `ws-${nextStepId++}`,
      order: i + 1,
      name: s.name,
      type: s.type,
      config: s.config,
      status: 'pending' as const,
    }));
  }
  return wf;
}

export async function toggleWorkflowStatus(id: string, _requester: AuthPayload): Promise<WorkflowDetail | null> {
  const wf = MOCK_WORKFLOWS.find((w) => w.id === id);
  if (!wf) return null;

  wf.status = wf.status === 'active' ? 'paused' : 'active';
  return wf;
}

export async function executeWorkflow(id: string, _requester: AuthPayload): Promise<WorkflowExecution | null> {
  const wf = MOCK_WORKFLOWS.find((w) => w.id === id);
  if (!wf) return null;

  // Mock execution — in production this would enqueue a BullMQ job
  const exec: WorkflowExecution = {
    id: `we-${nextExecId++}`,
    startedAt: new Date().toISOString(),
    completedAt: new Date(Date.now() + 2000).toISOString(),
    status: 'completed',
    stepsCompleted: wf.steps.length,
    stepsTotal: wf.steps.length,
    result: `Mock execution — ${wf.steps.length} steps completed (real execution requires LeadByte + Xero)`,
  };

  wf.recentExecutions.unshift(exec);
  wf.totalRuns++;
  wf.lastRunAt = exec.startedAt;
  return exec;
}

export function getStepTypes(): string[] {
  return STEP_TYPES;
}
