// TEST-ONLY smoke contracts; these are not agreed product/API contracts.
export const WORKER_SENTINEL = 'WORKER_SENTINEL_fixture_7f39a2';
export const SUPERVISOR_SENTINEL = 'SUPERVISOR_SENTINEL_fixture_b821ce';

export const workerSmokeOutput = {
  name: 'lct_worker_smoke_v1',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['ok'] },
      summary: { type: 'string', maxLength: 120 },
      nextAction: { type: 'string', maxLength: 80 },
    },
    required: ['status', 'summary', 'nextAction'],
  },
  validate(value) {
    return value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).length === 3
      && value.status === 'ok'
      && typeof value.summary === 'string'
      && value.summary.length <= 120
      && typeof value.nextAction === 'string'
      && value.nextAction.length <= 80;
  },
};

export const supervisorSmokeOutput = {
  name: 'lct_supervisor_smoke_v1',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      decision: { type: 'string', enum: ['pass', 'warn', 'repair'] },
      reason: { type: 'string', maxLength: 120 },
    },
    required: ['decision', 'reason'],
  },
  validate(value) {
    return value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).length === 2
      && ['pass', 'warn', 'repair'].includes(value.decision)
      && typeof value.reason === 'string'
      && value.reason.length <= 120;
  },
};

export function workerSmokeRequest() {
  return {
    role: 'worker',
    operation: 'smoke.worker',
    messages: [
      { role: 'system', content: 'Worker smoke context. Summarize only the evidence in this request.' },
      { role: 'user', content: 'Evidence: ' + WORKER_SENTINEL },
    ],
    output: workerSmokeOutput,
    maxOutputTokens: 96,
    temperature: 0,
    metadata: { projectId: 'smoke-project', generationId: 'smoke-generation', checkpointId: 'smoke-checkpoint' },
  };
}

export function supervisorSmokeRequest() {
  return {
    role: 'supervisor',
    operation: 'smoke.supervisor',
    messages: [
      { role: 'system', content: 'Supervisor smoke context. Review only the checkpoint evidence in this request.' },
      { role: 'user', content: 'Checkpoint evidence: ' + SUPERVISOR_SENTINEL },
    ],
    output: supervisorSmokeOutput,
    maxOutputTokens: 96,
    temperature: 0,
    metadata: { projectId: 'smoke-project', generationId: 'smoke-generation', checkpointId: 'smoke-checkpoint' },
  };
}
