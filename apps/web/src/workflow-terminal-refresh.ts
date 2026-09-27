type PersistedWorkflowRefreshers = {
  template: () => Promise<unknown>;
  planning: () => Promise<unknown>;
};

/** Refresh server-owned snapshots after a workflow reaches either terminal state. */
export async function refreshPersistedWorkflowSnapshots(
  status: string | null | undefined,
  refreshers: PersistedWorkflowRefreshers,
): Promise<boolean> {
  if (status !== 'ready' && status !== 'failed') return false;
  await Promise.all([refreshers.template(), refreshers.planning()]);
  return true;
}
