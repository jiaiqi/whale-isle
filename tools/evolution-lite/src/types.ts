import { z } from 'zod';

export const TicketStatusSchema = z.enum([
  'PENDING',
  'NEXT',
  'DOING',
  'IMPLEMENTED_UNVERIFIED',
  'BLOCKED',
  'DONE',
  'REOPENED',
]);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

export const EvolutionTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  branchName: z.string().min(1),
  baseBranch: z.string().min(1).default('feat/whale-isle-v2'),
  status: TicketStatusSchema.default('PENDING'),
  dependsOn: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  requiresRealDeviceVerification: z.boolean().default(false),
  maxFiles: z.number().int().positive().default(8),
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EvolutionTask = z.output<typeof EvolutionTaskSchema>;
export type EvolutionTaskInput = z.input<typeof EvolutionTaskSchema>;

export const EvolutionHistoryEntrySchema = z.object({
  at: z.string(),
  taskId: z.string(),
  fromStatus: TicketStatusSchema,
  toStatus: TicketStatusSchema,
  reason: z.string(),
});
export type EvolutionHistoryEntry = z.infer<typeof EvolutionHistoryEntrySchema>;

export const EvolutionStateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  activeTaskId: z.string().nullable().default(null),
  tasks: z.array(EvolutionTaskSchema).default([]),
  history: z.array(EvolutionHistoryEntrySchema).default([]),
});
export type EvolutionState = z.output<typeof EvolutionStateSchema>;

export interface ReviewFinding {
  severity: 'error' | 'warn';
  rule: string;
  message: string;
  file?: string;
}

export interface ReviewResult {
  approved: boolean;
  findings: ReviewFinding[];
  summary: string;
}

export interface GateRunResult {
  ok: boolean;
  summary: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface PrDraft {
  taskId: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  bodyMarkdown: string;
  ghCreateArgs: string[];
}

export interface ExecutionReport {
  taskId: string;
  outcome: 'READY_FOR_REVIEW' | 'IMPLEMENTED_UNVERIFIED' | 'BLOCKED';
  worktreePath: string;
  branchName: string;
  agentName: string;
  changedFiles: string[];
  gateResult?: GateRunResult;
  reviewResult?: ReviewResult;
  prDraft?: PrDraft;
  failureReason?: string;
  startedAt: string;
  finishedAt: string;
}
