import { createHash } from 'node:crypto';

import workflowContract from '../contracts/agent-workflows.v1.json' with { type: 'json' };

export type AgentWorkflowRole = 'worker' | 'supervisor';
export interface AgentWorkflowVersion {
  agentId: string;
  agentVersion: string;
  skillId: string;
  skillVersion: string;
  promptVersion: string;
  schemaVersion: string;
  modelRole: string;
}
export interface AgentWorkflowVersions {
  worker: AgentWorkflowVersion;
  supervisor: AgentWorkflowVersion;
}

export const AGENT_WORKFLOW_CONTRACT = workflowContract;
// Planning snapshots depend only on the planning agents; contextual-auditor-only changes must not stale a DeckPlan.
export const AGENT_WORKFLOW_CONTRACT_SHA256 = createHash('sha256').update(JSON.stringify({
  worker: workflowContract.agents.worker,
  supervisor: workflowContract.agents.supervisor,
})).digest('hex');
export const CONTEXTUAL_AUDITOR_WORKFLOW = { ...workflowContract.agents.contextualAuditor };
export const CONTEXTUAL_AUDITOR_CONTRACT_SHA256 = createHash('sha256')
  .update(JSON.stringify(CONTEXTUAL_AUDITOR_WORKFLOW)).digest('hex');
export const AGENT_WORKFLOW_VERSIONS: AgentWorkflowVersions = {
  worker: { ...workflowContract.agents.worker },
  supervisor: { ...workflowContract.agents.supervisor },
};

export function isAgentWorkflowVersions(value: unknown): value is AgentWorkflowVersions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = ['agentId', 'agentVersion', 'skillId', 'skillVersion', 'promptVersion', 'schemaVersion', 'modelRole'];
  return ['worker', 'supervisor'].every((role) => {
    const workflow = record[role];
    if (typeof workflow !== 'object' || workflow === null || Array.isArray(workflow)) return false;
    const item = workflow as Record<string, unknown>;
    return Object.keys(item).length === keys.length && keys.every((key) => typeof item[key] === 'string' && (item[key] as string).length > 0 && (item[key] as string).length <= 120);
  }) && Object.keys(record).length === 2;
}

export const LEGACY_UNRECORDED_WORKFLOW_VERSIONS: AgentWorkflowVersions = {
  worker: { agentId: 'unknown', agentVersion: 'unrecorded', skillId: 'unknown', skillVersion: 'unrecorded', promptVersion: 'unknown', schemaVersion: 'unknown', modelRole: 'worker' },
  supervisor: { agentId: 'unknown', agentVersion: 'unrecorded', skillId: 'unknown', skillVersion: 'unrecorded', promptVersion: 'unknown', schemaVersion: 'unknown', modelRole: 'supervisor' },
};
