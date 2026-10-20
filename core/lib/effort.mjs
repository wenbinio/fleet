const standard = Object.freeze(["low", "medium", "high"]);
const extended = Object.freeze([...standard, "xhigh"]);

// Shared by validation, runners, schemas and the model menu. null means any
// non-empty string; unsupported backends are deliberately absent.
export const EFFORT_RULES = Object.freeze({
  codex: extended,
  image: extended,
  grok: null,
  api: standard,
  advisor: standard,
  local: standard,
});
export const CHATGPT_EFFORT_ERROR = "chatgpt always runs at full power";
export const supportsEffort = backend => Object.hasOwn(EFFORT_RULES, backend);
export function effortValues(backend) {
  return EFFORT_RULES[backend]?.join("|") ?? "any non-empty string";
}
export function validateEffort(backend, value) {
  if (value === undefined) return;
  if (backend === "chatgpt") throw new Error(CHATGPT_EFFORT_ERROR);
  if (!supportsEffort(backend)) throw new Error(`effort is ${Object.keys(EFFORT_RULES).join(" or ")} only`);
  if (typeof value !== "string" || !value.trim()) throw new Error("effort must be a non-empty string");
  if (EFFORT_RULES[backend] && !EFFORT_RULES[backend].includes(value)) throw new Error(`invalid effort for ${backend}; expected ${effortValues(backend)}`);
  return value;
}
export function effortNote(backend) {
  return supportsEffort(backend) ? `effort: ${effortValues(backend)}` : backend === "chatgpt" ? `effort: ${CHATGPT_EFFORT_ERROR}` : null;
}
// Backends sharing values are grouped to keep the always-on schema short.
const effortGroups = Object.keys(EFFORT_RULES).reduce((groups, backend) => {
  const values = EFFORT_RULES[backend] ? effortValues(backend) : "any";
  (groups[values] ??= []).push(backend);
  return groups;
}, {});
export const EFFORT_DESCRIPTION = Object.entries(effortGroups).map(([values, backends]) => `${backends.join("/")}: ${values}`).join("; ") + "; not chatgpt.";
