// CLI tests exercise coordinator behavior regardless of the test runner's role.
// Apply explicit overrides last so worker-guard regression tests can opt in.
export function cliTestEnv(extra = {}) {
  const env = { ...process.env };
  delete env.AGENT_BRIDGE_WORKER;
  return { ...env, ...extra };
}
