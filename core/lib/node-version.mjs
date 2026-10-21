// One policy for standalone installation and the agent-toolkit setup wrapper.
export function nodeVersionPolicy(version) {
  const major = Number(/^v?(\d+)\./.exec(String(version))?.[1]);
  if (!Number.isInteger(major) || major < 24) return { supported: false, warning: 'install Node 24 LTS' };
  return { supported: true, warning: major % 2 ? 'odd-numbered Node releases are short-lived; use 24 LTS' : null };
}
