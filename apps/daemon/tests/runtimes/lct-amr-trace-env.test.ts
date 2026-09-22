import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  lctAmrRunAttempt,
  lctAmrTraceEnv,
} from '../../src/runtimes/env.js';

test('lctAmrRunAttempt counts cumulative retries and manual recharge resumes', () => {
  assert.equal(
    lctAmrRunAttempt({
      cumulativeRetryAttemptCount: 1,
      retryAttemptCount: 2,
      manualResumeAttemptCount: 1,
    }),
    4,
  );
  assert.equal(
    lctAmrRunAttempt({
      manualResumeAttemptCount: 1,
    }),
    1,
  );
});

test('lctAmrTraceEnv builds LCT trace identity env for AMR only', () => {
  const amrEnv = lctAmrTraceEnv({
    agentId: 'amr',
    runId: ' run_trace_123 ',
    runAttempt: 2,
    conversationId: ' conversation_trace_456 ',
  });

  assert.equal(amrEnv.LCT_RUN_ID, 'run_trace_123');
  assert.equal(amrEnv.LCT_RUN_ATTEMPT, '2');
  assert.equal(amrEnv.LCT_SESSION_ID, 'conversation_trace_456');

  const claudeEnv = lctAmrTraceEnv({
    agentId: 'claude',
    runId: 'run_trace_123',
    runAttempt: 2,
    conversationId: 'conversation_trace_456',
  });

  assert.deepEqual(claudeEnv, {});
});

test('lctAmrTraceEnv omits optional AMR session trace env when no conversation exists', () => {
  const env = lctAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_no_session',
    runAttempt: 0,
  });

  assert.equal(env.LCT_RUN_ID, 'run_trace_no_session');
  assert.equal(env.LCT_RUN_ATTEMPT, '0');
  assert.equal(env.LCT_SESSION_ID, undefined);
});

test('lctAmrTraceEnv fails fast on invalid AMR trace inputs', () => {
  assert.throws(
    () => lctAmrTraceEnv({ agentId: 'amr', runId: ' ', runAttempt: 0 }),
    /LCT_RUN_ID/,
  );
  assert.throws(
    () => lctAmrTraceEnv({ agentId: 'amr', runId: 'run_trace', runAttempt: -1 }),
    /LCT_RUN_ATTEMPT/,
  );
});

// Vela's workspace-credit isolation (spec: workspace-scoped wallet and
// credit isolation) attributes an AMR spend by the LCT_WORKSPACE_ID
// env the daemon forwards to the vela CLI, which the CLI turns into
// `X-LCT-Workspace-Id` + `x-vela-workspace-id` request headers.
test('lctAmrTraceEnv forwards an exact persisted workspace id for AMR runs', () => {
  const env = lctAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_team',
    runAttempt: 0,
    workspaceId: ' workspace_team_123 ',
  });

  assert.equal(env.LCT_WORKSPACE_ID, 'workspace_team_123');
});

test('lctAmrTraceEnv forwards a persisted Personal workspace id too', () => {
  const env = lctAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_personal',
    runAttempt: 0,
    workspaceId: ' workspace_personal_123 ',
  });
  assert.equal(env.LCT_WORKSPACE_ID, 'workspace_personal_123');
});

// Null/undefined/blank means the caller found no persisted binding at all.
// Only that genuinely unbound historical-project case omits the env var.
test('lctAmrTraceEnv omits LCT_WORKSPACE_ID only without a persisted binding', () => {
  const withNull = lctAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_unbound',
    runAttempt: 0,
    workspaceId: null,
  });
  assert.equal('LCT_WORKSPACE_ID' in withNull, false);

  const withUndefined = lctAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_unbound_2',
    runAttempt: 0,
  });
  assert.equal('LCT_WORKSPACE_ID' in withUndefined, false);

  const withBlank = lctAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_unbound_3',
    runAttempt: 0,
    workspaceId: '   ',
  });
  assert.equal('LCT_WORKSPACE_ID' in withBlank, false);
});

test('lctAmrTraceEnv never forwards workspaceId for non-AMR agents', () => {
  const env = lctAmrTraceEnv({
    agentId: 'claude',
    runId: 'run_trace_123',
    runAttempt: 0,
    workspaceId: 'workspace_team_123',
  });
  assert.deepEqual(env, {});
});

test('lctAmrTraceEnv forwards only bounded plugin correlation to Vela', () => {
  const env = lctAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_plugin',
    runAttempt: 0,
    externalPluginAnalytics: {
      pluginWorkflowId: '018f6f2e-4444-7444-8444-444444444444',
      logicalRequestDigest: 'a'.repeat(64),
      logicalRequestDigestVersion: 1,
      externalPluginId: 'lct',
      externalPluginVersion: '0.4.0',
      distributionMechanism: 'git_marketplace',
      publisherClass: 'lct_first_party',
      apiKey: 'must-not-forward',
      accountId: 'must-not-forward',
    },
  });

  assert.equal(
    env.LCT_PLUGIN_WORKFLOW_ID,
    '018f6f2e-4444-7444-8444-444444444444',
  );
  assert.equal(env.LCT_LOGICAL_REQUEST_DIGEST, 'a'.repeat(64));
  assert.equal(env.LCT_LOGICAL_REQUEST_DIGEST_VERSION, '1');
  assert.equal(env.LCT_EXTERNAL_PLUGIN_ID, 'lct');
  assert.equal(env.LCT_EXTERNAL_PLUGIN_VERSION, '0.4.0');
  assert.equal(env.LCT_DISTRIBUTION_MECHANISM, 'git_marketplace');
  assert.equal(
    env.LCT_PUBLISHER_CLASS,
    'lct_first_party',
  );
  assert.equal(env.LCT_API_KEY, undefined);
  assert.equal(env.LCT_ACCOUNT_ID, undefined);
});
