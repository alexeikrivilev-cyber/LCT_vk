export function orderAgentsWithLCTFirst<T extends { id: string }>(
  agents: readonly T[],
): T[] {
  const lctAgents: T[] = [];
  const otherAgents: T[] = [];
  for (const agent of agents) {
    if (agent.id === 'amr') {
      lctAgents.push(agent);
    } else {
      otherAgents.push(agent);
    }
  }
  return [...lctAgents, ...otherAgents];
}
