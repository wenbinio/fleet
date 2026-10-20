import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadToolkit } from "./toolkit-link.mjs";

export function finalText(event) {
  const value = event.text ?? event.content ?? (typeof event.message === "string" ? event.message : event.message?.content) ?? (typeof event.data === "string" ? event.data : event.data?.text ?? event.data?.content) ?? event.output ?? event.answer ?? event.result;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(part => typeof part === "string" ? part : part.text ?? "").join("");
  return "";
}
const runner = (repo, backend, args) => ({ exe: process.execPath, args: [path.join(repo, "lib", "runners.mjs"), `${backend}-run`, ...args] });
const prompt = directory => path.join(directory, "prompt.txt");
const dirs = run => (run.addDirs ?? []).flatMap(dir => ["--add-dir", dir]);
const textTranscript = (run, { directory }) => ({ format: "text", directory });
const jsonResult = stdout => {
  const data = JSON.parse(stdout);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid runner result");
  return data;
};
export const LIVE_STATUSES = new Set(["running", "waiting_for_lok"]);
export const ADVISOR_NOTICE = "A Google check is waiting in a Chrome window for Lok";
function artifactFiles(root, accept) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      // Do not follow links out of the run's artifact tree.
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && accept(file)) files.push({ path: file, bytes: fs.statSync(file).size });
    }
  };
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function copyArtifacts(files, root, outDir) {
  const result = [...files];
  if (!outDir) return result;
  for (const file of files) {
    const destination = path.join(outDir, path.relative(root, file.path));
    if (path.resolve(destination) === path.resolve(file.path)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // An existing asset in the chosen output directory must not be overwritten.
    fs.copyFileSync(file.path, destination, fs.constants.COPYFILE_EXCL);
    result.push({ path: destination, bytes: fs.statSync(destination).size });
  }
  return result;
}
const imageFile = file => /\.(png|webp|jpe?g)$/i.test(file);
const readText = file => { try { return fs.readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return ""; throw error; } };
const artifactTranscript = (run, context) => ({ ...textTranscript(run, context), details: { files: run.files ?? [] } });
function sessionResume(opts, resumed, existing, backend, field) {
  if (!opts.resume) return;
  if (resumed?.kind !== "ask" || resumed.backend !== backend || !resumed[field]) throw new Error(`resume must name an earlier ${backend} ask run with a saved session`);
  if (existing.some(r => r.backend === backend && r[field] === resumed[field] && LIVE_STATUSES.has(r.status))) throw new Error(`that ${backend === "codex" ? "Codex" : backend} session is still running; wait before resuming`);
}

// All backend-specific defaults, option rules, invocation, parsing and transcript
// handling live here. The store and detached worker only manage job lifecycle.
export const ADAPTERS = {
  codex: {
    defaults: { model: "astra", effort: "high" },
    allowed: ["cwd", "model", "effort", "readOnly", "addDirs", "resume"],
    required: ["cwd"],
    validate(opts) { if (opts.effort !== undefined && !["low", "medium", "high", "xhigh"].includes(opts.effort)) throw new Error("invalid effort"); },
    resume: (opts, resumed, existing) => sessionResume(opts, resumed, existing, "codex", "codexId"),
    prepare: (opts, { runId, resumed }) => ({ codexId: resumed?.codexId ?? runId }),
    command(run, { directory, repo }) {
      return runner(repo, "codex", [run.codexId, prompt(directory), "--model", run.model, "--cwd", run.cwd, "--effort", run.effort, ...(run.readOnly ? ["--read-only"] : []), ...dirs(run), ...(run.resume ? ["--resume", "last"] : [])]);
    },
    line(text, state, run) {
      const escaped = run.codexId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = text.match(new RegExp(`^\\[${escaped}\\] round (\\d+) exit (-?\\d+), session (.+)$`));
      if (match) state.summary = { codexRound: Number(match[1]), session: match[3].trim() };
    },
    parse({ state, run, toolkit, env, exitCode, interrupted }) {
      const metadata = state.summary ?? {};
      let answer = "";
      if (state.summary) {
        const root = path.join(toolkit.loadConfig(env).runsDir, "codex", run.codexId);
        metadata.eventsPath = path.join(root, `r${metadata.codexRound}.events.jsonl`);
        try { answer = fs.readFileSync(path.join(root, `r${metadata.codexRound}.last.txt`), "utf8"); }
        catch (error) { if (!exitCode && !interrupted) throw new Error(`cannot read Codex final answer: ${error.message}`); }
      }
      return { answer, metadata };
    },
    async transcript(run, { env }) {
      if (run.eventsPath) return { format: "events", file: run.eventsPath };
      const { toolkit } = await loadToolkit({ env });
      const root = path.join(toolkit.loadConfig(env).runsDir, "codex", run.codexId);
      try {
        const rounds = fs.readdirSync(root).filter(n => /^r\d+\.events\.jsonl$/.test(n)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
        return { format: "events", file: rounds[0] ? path.join(root, rounds[0]) : null };
      } catch (error) { if (error.code === "ENOENT") return { format: "events", file: null }; throw error; }
    },
  },
  agy: {
    defaults: { model: "gemini-3.8-flash-low" },
    allowed: ["cwd", "model", "addDirs", "jsonSchema"], maxLive: 4, deniedCodes: [3],
    outputFile: "answer.txt",
    command: (run, { directory, repo }) => runner(repo, "agy", [prompt(directory), "--model", run.model, ...(run.cwd ? ["--add-dir", run.cwd] : []), ...dirs(run), ...(run.jsonSchema ? ["--json-schema", run.jsonSchema] : [])]),
    parse: ({ directory }) => ({ answer: fs.readFileSync(path.join(directory, "answer.txt"), "utf8") }),
    transcript: textTranscript,
  },
  deepseek: {
    defaults: { model: "deepseek-flash" },
    allowed: ["cwd", "model"], required: ["cwd"], outputFile: "events.jsonl",
    validate(opts) { if (opts.model !== undefined && !["deepseek-flash", "deepseek-v4-pro"].includes(opts.model)) throw new Error("invalid deepseek model"); },
    command: (run, { directory, repo }) => ({ exe: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repo, "bin", "dsh-run.ps1"), "-Task", prompt(directory), "-Cwd", run.cwd, "-Model", run.model] }),
    line(text, state) {
      try {
        const event = JSON.parse(text);
        const session = event.session_id ?? event.sessionId ?? (typeof event.session === "string" ? event.session : event.session?.id) ?? event.data?.session_id ?? event.data?.sessionId ?? event.data?.session?.id;
        if (typeof session === "string") state.session = session;
        if (event.type === "final" || event.event === "final") {
          const text = finalText(event);
          if (text) (state.answers ??= []).push(text);
        }
      } catch { /* Raw events are retained even if a line cannot be parsed. */ }
    },
    parse: ({ state }) => ({ answer: (state.answers ?? []).join("\n"), metadata: state.session ? { session: state.session } : {} }),
    transcript: (run, { directory }) => ({ format: "events", file: path.join(directory, "events.jsonl") }),
  },
  grok: {
    defaults: { model: "grok-4.7" },
    allowed: ["cwd", "model", "effort", "resume"], maxLive: 4, deniedCodes: [3], json: true,
    resume: (opts, resumed, existing) => sessionResume(opts, resumed, existing, "grok", "session"),
    prepare: (opts, { resumed }) => resumed ? { resumeSession: resumed.session, session: resumed.session } : {},
    command: (run, { directory, repo }) => runner(repo, "grok", [prompt(directory), "--json", "--cwd", run.cwd ?? directory, "--model", run.model, ...(run.effort ? ["--effort", run.effort] : []), ...(run.resumeSession ? ["--resume", run.resumeSession] : [])]),
    parse({ stdout, exitCode }) {
      if (exitCode !== 0 && exitCode !== 3) return { answer: "" };
      const data = jsonResult(stdout);
      return { answer: exitCode === 3 ? "" : data.answer ?? "", metadata: { session: data.sessionId, stopReason: data.stopReason, usage: data.usage } };
    },
    transcript: (run, context) => ({ ...textTranscript(run, context), details: { stopReason: run.stopReason, usage: run.usage } }),
  },
  api: {
    defaults: {}, allowed: ["provider", "model", "maxTokens", "maxCostUsd", "system"], maxLive: 8, json: true,
    async prepare(opts, { repo, env }) {
      const api = await import(pathToFileURL(path.join(repo, "lib", "api.mjs")).href);
      const service = api.provider(opts.provider, { env });
      const rule = api.modelRules(opts.model, opts.maxCostUsd, service);
      return { provider: service.name, model: rule.model, requestedModel: rule.model, free: rule.free };
    },
    command: (run, { directory, repo }) => runner(repo, "api", [prompt(directory), "--json", "--provider", run.provider, "--model", run.requestedModel ?? run.model, ...(run.maxTokens !== undefined ? ["--max-tokens", String(run.maxTokens)] : []), ...(run.maxCostUsd !== undefined ? ["--max-cost", String(run.maxCostUsd)] : []), ...(run.system ? ["--system", run.system] : [])]),
    parse({ stdout, exitCode }) {
      if (!stdout.trim()) return { answer: "", status: exitCode === 3 ? "denied" : "failed" };
      const data = jsonResult(stdout);
      if (!["done", "failed", "denied", "empty", "rate_limited", "daily_limit"].includes(data.outcome)) throw new Error("invalid API outcome");
      const metadata = Object.fromEntries(["model", "requestedModel", "provider", "free", "costUsd", "overCap", "usage"].filter(key => data[key] !== undefined).map(key => [key, data[key]]));
      return { answer: data.answer ?? "", reasoning: data.reasoning ?? "", status: data.outcome === "done" && exitCode !== 0 ? "failed" : data.outcome, error: data.error, metadata };
    },
    transcript: (run, context) => ({ ...textTranscript(run, context), reasoning: true, details: { requestedModel: run.requestedModel, model: run.model, provider: run.provider, free: run.free, usage: run.usage, costUsd: run.costUsd } }),
    row: run => ({ requestedModel: run.requestedModel, provider: run.provider, free: run.free, costUsd: run.costUsd ?? 0 }),
    spend: run => Number.isFinite(run.costUsd) && run.costUsd > 0 ? run.costUsd : 0,
  },
  image: {
    defaults: { model: "sol", effort: "high" }, allowed: ["model", "effort", "images", "outDir"], maxLive: 2,
    validate(opts) { if (opts.effort !== undefined && !["low", "medium", "high", "xhigh"].includes(opts.effort)) throw new Error("invalid effort"); },
    before({ directory, state }) { state.beforeFiles = new Set(artifactFiles(directory, imageFile).map(file => file.path)); },
    command: (run, { directory, repo }) => ({ exe: process.execPath, args: [path.join(repo, "lib", "runners.mjs"), "codex-image", directory, ...(run.images ?? []), "--model", run.model, "--effort", run.effort] }),
    parse({ directory, run, state, exitCode, interrupted }) {
      const produced = artifactFiles(directory, imageFile).filter(file => !state.beforeFiles.has(file.path));
      const files = !exitCode && !interrupted ? copyArtifacts(produced, directory, run.outDir) : produced;
      return { answer: readText(path.join(directory, "log.txt")).slice(-3000), metadata: { files }, status: !exitCode && produced.length ? "done" : "failed", ...(!produced.length ? { error: "no images produced" } : {}) };
    },
    transcript: artifactTranscript,
  },
  advisor: {
    defaults: { model: "argon" }, allowed: ["files", "lokAsked"], maxLive: 2,
    validate(opts) { if (opts.lokAsked !== true) throw new Error("advisor runs only when Lok asks for Argon"); },
    command: (run, { directory, repo }) => ({ exe: process.execPath, args: [path.join(repo, "skills", "gemini-advisor", "advisor.mjs"), "ask", prompt(directory), ...(run.files?.length ? ["--files", ...run.files] : []), "--out", path.join(directory, "answer.md")] }),
    stderrLine(line) {
      const start = line.indexOf("{");
      if (start < 0) return;
      let event; try { event = JSON.parse(line.slice(start)); } catch { return; }
      if (Object.hasOwn(event, "waitingForLok") && event.waitingForLok) return { status: "waiting_for_lok", notice: ADVISOR_NOTICE };
      if (event.challenge === "cleared") return { status: "running", notice: undefined };
    },
    parse: ({ directory }) => ({ answer: readText(path.join(directory, "answer.md")) }),
    transcript: textTranscript,
  },
  sound: {
    defaults: { engine: "sao", takes: 1, music: false }, allowed: ["engine", "seconds", "takes", "seed", "music", "outDir"], maxLive: 1,
    validate(opts) {
      if (opts.engine !== undefined && !["sao", "moss"].includes(opts.engine)) throw new Error("engine must be sao or moss");
      if (typeof opts.seconds !== "number" || !Number.isFinite(opts.seconds) || opts.seconds < 0.5 || opts.seconds > 47) throw new Error("seconds must be between 0.5 and 47");
      if (opts.takes !== undefined && (!Number.isInteger(opts.takes) || opts.takes < 1 || opts.takes > 5)) throw new Error("takes must be between 1 and 5");
      if (opts.seed !== undefined && !Number.isSafeInteger(opts.seed)) throw new Error("seed must be an integer");
      if (opts.music !== undefined && typeof opts.music !== "boolean") throw new Error("music must be a boolean");
      if (opts.engine === "moss" && opts.music) throw new Error("moss does not support music");
    },
    prepare: opts => ({ model: opts.engine ?? "sao" }),
    async before({ run, directory, repo, toolkit, env, state, platform }) {
      const media = await import(pathToFileURL(path.join(repo, "lib", "media.mjs")).href);
      state.tools = media.soundTools(toolkit.loadConfig(env), { platform });
      if (!state.tools[run.engine]) throw new Error(`${run.engine} sound tools are missing; run node setup.mjs`);
      state.cues = Array.from({ length: run.takes }, (_, i) => ({ key: `take-${i + 1}`, prompt: readText(prompt(directory)), seconds: run.seconds, seed: (run.seed ?? 1) + i, steps: 100, music: run.music }));
      fs.writeFileSync(path.join(directory, "cues.json"), JSON.stringify(state.cues, null, 2) + "\n");
    },
    command(run, { directory, state }) {
      const { tools, cues } = state, raw = path.join(directory, "raw"), norm = path.join(directory, "norm"), web = path.join(directory, "web"), cueFile = path.join(directory, "cues.json");
      return run.engine === "moss" ? [
        { exe: tools.mossPython, args: [tools.mossGen, cueFile, raw] },
        { exe: tools.mossPython, args: [tools.peakNorm, raw, norm] },
        { exe: tools.saoPython, args: [tools.finish, norm, web] },
      ] : [
        { exe: tools.saoPython, args: [tools.gen, cueFile, raw] },
        { exe: tools.saoPython, args: [tools.finish, raw, web, ...(run.music ? ["--music", cues.map(cue => cue.key).join(",")] : [])] },
      ];
    },
    parse({ run, directory, exitCode, interrupted }) {
      const web = path.join(directory, "web"), produced = artifactFiles(web, file => /\.(ogg|m4a)$/i.test(file) || path.basename(file) === "sounds.json");
      const hasAudio = produced.some(file => /\.(ogg|m4a)$/i.test(file.path));
      const files = !exitCode && !interrupted && hasAudio ? copyArtifacts(produced, web, run.outDir) : produced;
      return { answer: files.map(file => file.path).join("\n"), metadata: { files }, status: !exitCode && hasAudio ? "done" : "failed", ...(!hasAudio ? { error: "no output files produced" } : {}) };
    },
    transcript: artifactTranscript,
  },
};
export const BACKENDS = Object.keys(ADAPTERS);
export const ASK_KEYS = [...new Set(["backend", "prompt", "promptFile", ...Object.values(ADAPTERS).flatMap(a => a.allowed)])];
export const TERMINAL_STATUSES = new Set(["done", "failed", "denied", "interrupted", "lost", "empty", "rate_limited", "daily_limit"]);
