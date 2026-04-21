import type { AuthPayload } from '../types/index.js';

// ─── Types ───

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface AuditEntry {
  action: string;
  user: string;
  timestamp: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'todo' | 'in_progress' | 'completed' | 'blocked';
  dueDate: string;
  category: string;
  createdBy: string;
  createdAt: string;
  comments: TaskComment[];
  auditLog: AuditEntry[];
}

export interface TaskStats {
  total: number;
  completed: number;
  in_progress: number;
  overdue: number;
  by_priority: {
    low: number;
    medium: number;
    high: number;
    urgent: number;
  };
}

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  defaultPriority: 'low' | 'medium' | 'high' | 'urgent';
  defaultCategory: string;
  steps: string[];
}

// ─── Mock Data ───

const MOCK_TASKS: Task[] = [
  {
    id: 't-1', title: 'Review Apex Media invoice batch', description: 'Review and approve the weekly invoice batch for Apex Media Ltd before sending.',
    assignee: 'Sam Owner', priority: 'high', status: 'todo', dueDate: '2026-04-16T17:00:00Z', category: 'billing',
    createdBy: 'Sam Owner', createdAt: '2026-04-14T09:00:00Z', comments: [
      { id: 'tc-1', taskId: 't-1', author: 'Finance Admin', text: 'Batch is ready for review — 12 invoices totalling £5,400.', createdAt: '2026-04-14T10:30:00Z' },
    ],
    auditLog: [
      { action: 'Task created', user: 'Sam Owner', timestamp: '2026-04-14T09:00:00Z' },
      { action: 'Comment added', user: 'Finance Admin', timestamp: '2026-04-14T10:30:00Z' },
    ],
  },
  {
    id: 't-2', title: 'Onboard GreenTech Solar', description: 'Complete onboarding checklist for GreenTech Solar: agreement, credit check, campaign setup.',
    assignee: 'Ops Manager', priority: 'high', status: 'in_progress', dueDate: '2026-04-18T17:00:00Z', category: 'onboarding',
    createdBy: 'Sam Owner', createdAt: '2026-04-10T08:00:00Z', comments: [
      { id: 'tc-2', taskId: 't-2', author: 'Ops Manager', text: 'Credit check done — score 67. Waiting on signed agreement.', createdAt: '2026-04-12T14:00:00Z' },
    ],
    auditLog: [
      { action: 'Task created', user: 'Sam Owner', timestamp: '2026-04-10T08:00:00Z' },
      { action: 'Status changed to In Progress', user: 'Ops Manager', timestamp: '2026-04-11T09:00:00Z' },
      { action: 'Comment added', user: 'Ops Manager', timestamp: '2026-04-12T14:00:00Z' },
    ],
  },
  {
    id: 't-3', title: 'Chase Delta Solutions overdue payment', description: 'Two invoices overdue for Delta Solutions. Follow up with Laura Davies.',
    assignee: 'Finance Admin', priority: 'urgent', status: 'in_progress', dueDate: '2026-04-15T12:00:00Z', category: 'collections',
    createdBy: 'Sam Owner', createdAt: '2026-04-08T10:00:00Z', comments: [
      { id: 'tc-3', taskId: 't-3', author: 'Finance Admin', text: 'Sent first reminder email. No response yet.', createdAt: '2026-04-10T09:00:00Z' },
      { id: 'tc-4', taskId: 't-3', author: 'Sam Owner', text: 'Call them directly if no response by EOD.', createdAt: '2026-04-10T11:00:00Z' },
    ],
    auditLog: [
      { action: 'Task created', user: 'Sam Owner', timestamp: '2026-04-08T10:00:00Z' },
      { action: 'Status changed to In Progress', user: 'Finance Admin', timestamp: '2026-04-09T08:00:00Z' },
      { action: 'Comment added', user: 'Finance Admin', timestamp: '2026-04-10T09:00:00Z' },
      { action: 'Comment added', user: 'Sam Owner', timestamp: '2026-04-10T11:00:00Z' },
    ],
  },
  {
    id: 't-4', title: 'Set up solar leads campaign for Brightfield', description: 'Configure new solar vertical campaign in LeadByte for Brightfield Corp.',
    assignee: 'Ops Manager', priority: 'medium', status: 'todo', dueDate: '2026-04-20T17:00:00Z', category: 'campaigns',
    createdBy: 'Ops Manager', createdAt: '2026-04-13T11:00:00Z', comments: [],
    auditLog: [
      { action: 'Task created', user: 'Ops Manager', timestamp: '2026-04-13T11:00:00Z' },
    ],
  },
  {
    id: 't-5', title: 'Monthly credit score review', description: 'Run credit checks for all active clients and flag any score drops > 10 points.',
    assignee: 'Finance Admin', priority: 'medium', status: 'completed', dueDate: '2026-04-12T17:00:00Z', category: 'compliance',
    createdBy: 'Sam Owner', createdAt: '2026-04-01T09:00:00Z', comments: [
      { id: 'tc-5', taskId: 't-5', author: 'Finance Admin', text: 'All checks complete. Delta Solutions flagged — score dropped to 42.', createdAt: '2026-04-12T15:00:00Z' },
    ],
    auditLog: [
      { action: 'Task created', user: 'Sam Owner', timestamp: '2026-04-01T09:00:00Z' },
      { action: 'Status changed to In Progress', user: 'Finance Admin', timestamp: '2026-04-02T08:00:00Z' },
      { action: 'Comment added', user: 'Finance Admin', timestamp: '2026-04-12T15:00:00Z' },
      { action: 'Status changed to Completed', user: 'Finance Admin', timestamp: '2026-04-12T16:00:00Z' },
    ],
  },
  {
    id: 't-6', title: 'Update Clearwater Digital lead pricing', description: 'Clearwater has agreed to new pricing of £24/lead, up from £22. Update in system.',
    assignee: 'Sam Owner', priority: 'low', status: 'completed', dueDate: '2026-04-10T17:00:00Z', category: 'billing',
    createdBy: 'Sam Owner', createdAt: '2026-04-08T14:00:00Z', comments: [],
    auditLog: [
      { action: 'Task created', user: 'Sam Owner', timestamp: '2026-04-08T14:00:00Z' },
      { action: 'Status changed to Completed', user: 'Sam Owner', timestamp: '2026-04-10T11:00:00Z' },
    ],
  },
  {
    id: 't-7', title: 'Fix duplicate lead delivery to Echo Marketing', description: 'Echo Marketing reported receiving duplicate leads on 2026-04-09. Investigate and resolve.',
    assignee: 'Ops Manager', priority: 'high', status: 'blocked', dueDate: '2026-04-16T17:00:00Z', category: 'support',
    createdBy: 'Ops Manager', createdAt: '2026-04-11T08:30:00Z', comments: [
      { id: 'tc-6', taskId: 't-7', author: 'Ops Manager', text: 'Blocked — waiting on LeadByte support to confirm the issue on their end.', createdAt: '2026-04-12T10:00:00Z' },
    ],
    auditLog: [
      { action: 'Task created', user: 'Ops Manager', timestamp: '2026-04-11T08:30:00Z' },
      { action: 'Status changed to In Progress', user: 'Ops Manager', timestamp: '2026-04-11T09:00:00Z' },
      { action: 'Status changed to Blocked', user: 'Ops Manager', timestamp: '2026-04-12T10:00:00Z' },
      { action: 'Comment added', user: 'Ops Manager', timestamp: '2026-04-12T10:00:00Z' },
    ],
  },
  {
    id: 't-8', title: 'Prepare Q1 revenue report', description: 'Compile Q1 revenue figures across all clients for Sam to review.',
    assignee: 'Finance Admin', priority: 'medium', status: 'completed', dueDate: '2026-04-05T17:00:00Z', category: 'reporting',
    createdBy: 'Sam Owner', createdAt: '2026-03-28T09:00:00Z', comments: [],
    auditLog: [
      { action: 'Task created', user: 'Sam Owner', timestamp: '2026-03-28T09:00:00Z' },
      { action: 'Status changed to Completed', user: 'Finance Admin', timestamp: '2026-04-04T16:00:00Z' },
    ],
  },
  {
    id: 't-9', title: 'Negotiate supplier rates for home improvement vertical', description: 'Contact top 3 suppliers for home improvement leads and negotiate better CPL.',
    assignee: 'Sam Owner', priority: 'medium', status: 'in_progress', dueDate: '2026-04-22T17:00:00Z', category: 'procurement',
    createdBy: 'Sam Owner', createdAt: '2026-04-07T10:00:00Z', comments: [
      { id: 'tc-7', taskId: 't-9', author: 'Sam Owner', text: 'Got preliminary quotes from 2 suppliers. Need 1 more.', createdAt: '2026-04-14T16:00:00Z' },
    ],
    auditLog: [
      { action: 'Task created', user: 'Sam Owner', timestamp: '2026-04-07T10:00:00Z' },
      { action: 'Status changed to In Progress', user: 'Sam Owner', timestamp: '2026-04-08T09:00:00Z' },
      { action: 'Comment added', user: 'Sam Owner', timestamp: '2026-04-14T16:00:00Z' },
    ],
  },
  {
    id: 't-10', title: 'Set up Xero integration for auto-invoicing', description: 'Configure Xero OAuth and test invoice sync for weekly auto-billing clients.',
    assignee: 'Sam Owner', priority: 'high', status: 'todo', dueDate: '2026-04-25T17:00:00Z', category: 'integrations',
    createdBy: 'Sam Owner', createdAt: '2026-04-14T08:00:00Z', comments: [],
    auditLog: [
      { action: 'Task created', user: 'Sam Owner', timestamp: '2026-04-14T08:00:00Z' },
    ],
  },
  {
    id: 't-11', title: 'Review Falcon Industries prospect', description: 'New prospect interested in solar leads. Review their requirements and prepare proposal.',
    assignee: 'Sam Owner', priority: 'medium', status: 'todo', dueDate: '2026-04-17T17:00:00Z', category: 'sales',
    createdBy: 'Sam Owner', createdAt: '2026-04-13T09:00:00Z', comments: [],
    auditLog: [
      { action: 'Task created', user: 'Sam Owner', timestamp: '2026-04-13T09:00:00Z' },
    ],
  },
  {
    id: 't-12', title: 'Validate lead quality for Clearwater campaigns', description: 'Audit 50 random leads from last week for Clearwater Digital to ensure quality standards.',
    assignee: 'Ops Manager', priority: 'medium', status: 'todo', dueDate: '2026-04-19T17:00:00Z', category: 'quality',
    createdBy: 'Ops Manager', createdAt: '2026-04-14T11:00:00Z', comments: [],
    auditLog: [
      { action: 'Task created', user: 'Ops Manager', timestamp: '2026-04-14T11:00:00Z' },
    ],
  },
  {
    id: 't-13', title: 'Heritage Finance account closure', description: 'Process final account closure for Heritage Finance. Write off remaining balance and archive.',
    assignee: 'Finance Admin', priority: 'low', status: 'blocked', dueDate: '2026-04-20T17:00:00Z', category: 'admin',
    createdBy: 'Sam Owner', createdAt: '2026-04-05T10:00:00Z', comments: [
      { id: 'tc-8', taskId: 't-13', author: 'Finance Admin', text: 'Blocked — need Sam to approve write-off of £1,800.', createdAt: '2026-04-08T14:00:00Z' },
    ],
    auditLog: [
      { action: 'Task created', user: 'Sam Owner', timestamp: '2026-04-05T10:00:00Z' },
      { action: 'Status changed to Blocked', user: 'Finance Admin', timestamp: '2026-04-08T14:00:00Z' },
      { action: 'Comment added', user: 'Finance Admin', timestamp: '2026-04-08T14:00:00Z' },
    ],
  },
  {
    id: 't-14', title: 'Weekly team standup notes', description: 'Document action items from this week\'s team standup meeting.',
    assignee: 'Ops Manager', priority: 'low', status: 'completed', dueDate: '2026-04-14T17:00:00Z', category: 'admin',
    createdBy: 'Ops Manager', createdAt: '2026-04-14T09:30:00Z', comments: [],
    auditLog: [
      { action: 'Task created', user: 'Ops Manager', timestamp: '2026-04-14T09:30:00Z' },
      { action: 'Status changed to Completed', user: 'Ops Manager', timestamp: '2026-04-14T15:00:00Z' },
    ],
  },
  {
    id: 't-15', title: 'Update supplier contracts for Q2', description: 'Review and renew supplier agreements for Q2. Ensure terms reflect new volume commitments.',
    assignee: 'Sam Owner', priority: 'high', status: 'todo', dueDate: '2026-04-30T17:00:00Z', category: 'procurement',
    createdBy: 'Sam Owner', createdAt: '2026-04-12T08:00:00Z', comments: [],
    auditLog: [
      { action: 'Task created', user: 'Sam Owner', timestamp: '2026-04-12T08:00:00Z' },
    ],
  },
  {
    id: 't-16', title: 'Investigate Brightfield lead rejection spike', description: 'Brightfield rejected 15% of leads last week, up from 3%. Find root cause.',
    assignee: 'Ops Manager', priority: 'urgent', status: 'in_progress', dueDate: '2026-04-15T17:00:00Z', category: 'quality',
    createdBy: 'Sam Owner', createdAt: '2026-04-14T07:00:00Z', comments: [
      { id: 'tc-9', taskId: 't-16', author: 'Ops Manager', text: 'Suspect one supplier sending bad data. Pulling reports now.', createdAt: '2026-04-14T12:00:00Z' },
    ],
    auditLog: [
      { action: 'Task created', user: 'Sam Owner', timestamp: '2026-04-14T07:00:00Z' },
      { action: 'Status changed to In Progress', user: 'Ops Manager', timestamp: '2026-04-14T08:00:00Z' },
      { action: 'Comment added', user: 'Ops Manager', timestamp: '2026-04-14T12:00:00Z' },
    ],
  },
];

const MOCK_TEMPLATES: TaskTemplate[] = [
  {
    id: 'tmpl-1', name: 'New Client Onboarding', description: 'Standard onboarding checklist for new clients.',
    defaultPriority: 'high', defaultCategory: 'onboarding',
    steps: ['Run credit check', 'Send agreement for signature', 'Set up billing profile', 'Configure first campaign', 'Schedule kickoff call'],
  },
  {
    id: 'tmpl-2', name: 'Monthly Credit Review', description: 'Run credit checks for all active clients and flag issues.',
    defaultPriority: 'medium', defaultCategory: 'compliance',
    steps: ['Pull active client list', 'Run credit checks via Endole', 'Flag score drops > 10 points', 'Notify owner of flagged accounts', 'Update client notes'],
  },
  {
    id: 'tmpl-3', name: 'Invoice Dispute Resolution', description: 'Process for handling client invoice disputes.',
    defaultPriority: 'high', defaultCategory: 'billing',
    steps: ['Log dispute details', 'Pull relevant lead data', 'Review with ops team', 'Prepare resolution proposal', 'Send credit note if applicable', 'Update invoice status'],
  },
  {
    id: 'tmpl-4', name: 'Campaign Launch', description: 'Checklist for launching a new lead generation campaign.',
    defaultPriority: 'high', defaultCategory: 'campaigns',
    steps: ['Confirm client requirements', 'Set up campaign in LeadByte', 'Configure lead routing', 'Set pricing and caps', 'Run test leads', 'Go live and monitor'],
  },
  {
    id: 'tmpl-5', name: 'Supplier Audit', description: 'Quarterly audit of supplier performance and compliance.',
    defaultPriority: 'medium', defaultCategory: 'procurement',
    steps: ['Pull lead quality metrics per supplier', 'Compare CPL against contracts', 'Check compliance documentation', 'Flag underperformers', 'Prepare renegotiation list'],
  },
];

let nextTaskId = 17;
let nextCommentId = 10;

// ─── Service ───

export interface TaskFilters {
  status?: string;
  priority?: string;
  assignee?: string;
  search?: string;
}

export async function listTasks(_requester: AuthPayload, filters?: TaskFilters): Promise<Task[]> {
  let tasks = [...MOCK_TASKS];

  if (filters?.status && filters.status !== 'all') {
    tasks = tasks.filter((t) => t.status === filters.status);
  }
  if (filters?.priority && filters.priority !== 'all') {
    tasks = tasks.filter((t) => t.priority === filters.priority);
  }
  if (filters?.assignee) {
    const a = filters.assignee.toLowerCase();
    tasks = tasks.filter((t) => t.assignee.toLowerCase().includes(a));
  }
  if (filters?.search) {
    const q = filters.search.toLowerCase();
    tasks = tasks.filter((t) =>
      t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  }

  return tasks;
}

export async function getTask(id: string): Promise<Task | null> {
  return MOCK_TASKS.find((t) => t.id === id) ?? null;
}

export async function createTask(data: Partial<Task>, _requester: AuthPayload): Promise<Task> {
  const now = new Date().toISOString();
  const task: Task = {
    id: `t-${nextTaskId++}`,
    title: data.title || '',
    description: data.description || '',
    assignee: data.assignee || '',
    priority: data.priority || 'medium',
    status: data.status || 'todo',
    dueDate: data.dueDate || new Date(Date.now() + 7 * 86400000).toISOString(),
    category: data.category || 'general',
    createdBy: _requester.email,
    createdAt: now,
    comments: [],
    auditLog: [{ action: 'Task created', user: _requester.email, timestamp: now }],
  };
  MOCK_TASKS.push(task);
  return task;
}

export async function updateTask(id: string, data: Partial<Task>): Promise<Task | null> {
  const task = MOCK_TASKS.find((t) => t.id === id);
  if (!task) return null;
  const { id: _id, comments: _comments, createdAt: _createdAt, createdBy: _createdBy, ...updatable } = data;
  Object.assign(task, updatable);
  return task;
}

export async function updateTaskStatus(id: string, status: Task['status']): Promise<Task | null> {
  const task = MOCK_TASKS.find((t) => t.id === id);
  if (!task) return null;
  const statusLabels: Record<string, string> = {
    todo: 'To Do', in_progress: 'In Progress', completed: 'Completed', blocked: 'Blocked',
  };
  task.status = status;
  task.auditLog.push({
    action: `Status changed to ${statusLabels[status] || status}`,
    user: task.assignee,
    timestamp: new Date().toISOString(),
  });
  return task;
}

export async function addComment(taskId: string, comment: { author: string; text: string }): Promise<TaskComment | null> {
  const task = MOCK_TASKS.find((t) => t.id === taskId);
  if (!task) return null;

  const newComment: TaskComment = {
    id: `tc-${nextCommentId++}`,
    taskId,
    author: comment.author,
    text: comment.text,
    createdAt: new Date().toISOString(),
  };
  task.comments.push(newComment);
  task.auditLog.push({
    action: 'Comment added',
    user: comment.author,
    timestamp: newComment.createdAt,
  });
  return newComment;
}

export async function getTaskStats(_requester: AuthPayload): Promise<TaskStats> {
  const now = new Date();
  return {
    total: MOCK_TASKS.length,
    completed: MOCK_TASKS.filter((t) => t.status === 'completed').length,
    in_progress: MOCK_TASKS.filter((t) => t.status === 'in_progress').length,
    overdue: MOCK_TASKS.filter((t) => t.status !== 'completed' && new Date(t.dueDate) < now).length,
    by_priority: {
      low: MOCK_TASKS.filter((t) => t.priority === 'low').length,
      medium: MOCK_TASKS.filter((t) => t.priority === 'medium').length,
      high: MOCK_TASKS.filter((t) => t.priority === 'high').length,
      urgent: MOCK_TASKS.filter((t) => t.priority === 'urgent').length,
    },
  };
}

// ─── Templates ───

export async function listTemplates(): Promise<TaskTemplate[]> {
  return MOCK_TEMPLATES;
}

export async function createFromTemplate(templateId: string, assignee: string, requester: AuthPayload): Promise<Task | null> {
  const template = MOCK_TEMPLATES.find((t) => t.id === templateId);
  if (!template) return null;

  const stepsDescription = template.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');

  const now = new Date().toISOString();
  const task: Task = {
    id: `t-${nextTaskId++}`,
    title: template.name,
    description: `${template.description}\n\nSteps:\n${stepsDescription}`,
    assignee,
    priority: template.defaultPriority,
    status: 'todo',
    dueDate: new Date(Date.now() + 7 * 86400000).toISOString(),
    category: template.defaultCategory,
    createdBy: requester.email,
    createdAt: now,
    comments: [],
    auditLog: [{ action: `Task created from template "${template.name}"`, user: requester.email, timestamp: now }],
  };
  MOCK_TASKS.push(task);
  return task;
}
