/**
 * The real Brain (ADR-0001) behind the `BrainAdapter` seam from #5: Claude reasoning in-context
 * each Run. There is no trained recommender or gap-detection algorithm — the taste judgement,
 * gap analysis, and lane choice are a single `claude -p` completion fed the Owned set as evidence.
 *
 * The picker (#5) consumes only the `BrainAdapter` interface and is **unchanged** by this file:
 * it asks `propose(ctx)` for ranked candidates across the three Lanes and weights the winner by
 * the chaos dial. This slice swaps the fake (`FakeBrainAdapter`) for the real thing.
 *
 * ## Shape: build → run → parse, with the subprocess injected
 * `ClaudeBrainAdapter` is deliberately dumb: it renders `BrainContext` into a prompt
 * (`buildBrainPrompt`), hands it to an injected `ClaudeRunner`, and parses the candidates back
 * (`parseBrainResponse`). The runner — a `claude -p` subprocess — is the one impure shell, injected
 * exactly like the `fetch` in `HttpPricingAdapter` so the adapter is exercised with no subprocess
 * in tests. All the prompt-shaping and response-parsing lives in pure functions, unit-tested.
 *
 * ## ADR-0001 invocation
 * `makeClaudeRunner` spawns `claude -p` in headless mode: the prompt is piped via **stdin** (robust
 * for a multi-KB taste brief — no argv length limit, no shell escaping), `--output-format json` so
 * the result is a stable envelope, `--max-turns 1` so it's a single bounded completion (no agentic
 * loop), and tools disabled (it's a pure judgement call, not a tool-using task). Auth is the Pro/Max
 * subscription via `CLAUDE_CODE_OAUTH_TOKEN` passed through the child env; **`--bare` is never passed**
 * (it bypasses that token — ADR-0001). A bounded timeout kills a hung run so a Run can't stall.
 */
import { spawn } from "node:child_process";
import type { Lane } from "@/store/types";
import type { BrainAdapter, BrainCandidate, BrainContext, OwnedAlbumContext } from "./types";

const LANES: readonly Lane[] = ["complete", "adjacent", "stretch"];
const DEFAULT_CLAUDE_BIN = "claude";
/** The Brain runs monthly and taste judgement is the whole point, so default to the most capable. */
const DEFAULT_BRAIN_MODEL = "opus";
/** OAuth tokens aren't refreshed mid-run and headless runs cap at ~10-15 min (ADR-0001); stay well under. */
const DEFAULT_TIMEOUT_MS = 9 * 60 * 1000;

// ── Prompt builder (pure) ───────────────────────────────────────────────────────

/** One owned album rendered as a compact taste line: tags + the rating/notes learning signal. */
function renderOwned(album: OwnedAlbumContext): string {
  const parts = [`- ${album.artist} — ${album.title}`];
  const tags = [...(album.genres ?? []), ...(album.styles ?? [])];
  if (tags.length) parts.push(`[${tags.join(", ")}]`);
  if (typeof album.rating === "number") parts.push(`(rated ${album.rating}/5)`);
  if (album.notes?.length) parts.push(`— note: ${album.notes.join("; ")}`);
  return parts.join(" ");
}

/**
 * Render `BrainContext` into the taste brief Claude reasons over. The contract it asks for matches
 * `parseBrainResponse`: a JSON object `{ "candidates": [...] }` with ranked picks across the lanes,
 * each tagged with its lane and a one-line `why` for the Reveal. The Owned set is taste evidence the
 * pick must never duplicate; the rejected keys are records already tried and passed over.
 */
export function buildBrainPrompt(ctx: BrainContext): string {
  const owned = ctx.owned.length
    ? ctx.owned.map(renderOwned).join("\n")
    : "(empty — this is a fresh collection)";
  const rejected = ctx.rejectedKeys.length ? ctx.rejectedKeys.join("\n") : "(none)";
  const { complete, adjacent, stretch } = ctx.chaosDial;

  return `You are the taste engine for a vinyl-record buying agent. Each month you pick records to
add to one person's collection, judging purely from their owned records as evidence — there is no
trained model, your in-context judgement IS the recommender.

Their OWNED collection (artist — title [genres/styles] (rating) — notes). Ratings and notes are the
strongest signal of what they actually love (ownership alone is not endorsement). NEVER propose a
record they already own:
${owned}

Records already REJECTED on past Runs (album keys "artist::title", lower-cased) — do NOT re-suggest:
${rejected}

Pick candidates across three LANES, best-first within each lane:
- "complete": fill out an artist/series they already collect (the safest, most expected pick).
- "adjacent": one step out — a neighbouring genre, scene, or era from what they own.
- "stretch": a bolder leap into territory they own little or none of.
This Run's appetite weighting is complete=${complete}, adjacent=${adjacent}, stretch=${stretch}
(relative weights; a downstream picker selects the lane — you just propose good candidates in each).

Respond with ONLY a JSON object, no prose, of this exact shape:
{"candidates":[{"artist":"...","title":"...","lane":"complete|adjacent|stretch","why":"one-line rationale shown to the user"}]}
Propose 2-4 candidates per lane. "why" must be a single concise sentence. Real, buyable vinyl
releases only.`;
}

// ── Response parser (pure, tolerant) ──────────────────────────────────────────────

function isLane(value: unknown): value is Lane {
  return typeof value === "string" && (LANES as readonly string[]).includes(value);
}

/** Coerce one loosely-typed object into a valid `BrainCandidate`, or null if it doesn't qualify. */
function toCandidate(raw: unknown): BrainCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const artist = typeof o.artist === "string" ? o.artist.trim() : "";
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const why = typeof o.why === "string" ? o.why.trim() : "";
  if (!artist || !title || !why || !isLane(o.lane)) return null;
  const candidate: BrainCandidate = { artist, title, lane: o.lane, why };
  if (typeof o.discogsReleaseId === "number" && Number.isFinite(o.discogsReleaseId)) {
    candidate.discogsReleaseId = o.discogsReleaseId;
  }
  return candidate;
}

/** Pull a candidate array out of an already-parsed JSON value (`[...]` or `{candidates:[...]}`). */
function candidatesFrom(value: unknown): BrainCandidate[] | null {
  const arr = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).candidates)
      ? ((value as Record<string, unknown>).candidates as unknown[])
      : null;
  if (!arr) return null;
  return arr.map(toCandidate).filter((c): c is BrainCandidate => c !== null);
}

/** Try to parse `text` as JSON, then scan for the first embedded `{...}`/`[...]` that yields candidates. */
function extractCandidates(text: string): BrainCandidate[] {
  const direct = tryParse(text);
  if (direct !== undefined) {
    const fromDirect = candidatesFrom(direct);
    if (fromDirect) return fromDirect;
  }
  // Prose around the JSON (or a ```json fence): scan every balanced object/array span for one that fits.
  for (const span of jsonSpans(text)) {
    const parsed = tryParse(span);
    if (parsed === undefined) continue;
    const cands = candidatesFrom(parsed);
    if (cands && cands.length) return cands;
  }
  return [];
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Yield candidate JSON substrings: every top-level balanced `{...}` and `[...]` span in `text`. */
function* jsonSpans(text: string): Generator<string> {
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === open) {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === close && depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) yield text.slice(start, i + 1);
      }
    }
  }
}

/**
 * Parse `claude -p` stdout into validated candidates. Tolerant by design (a single odd Run must
 * not crash the month): handles the `--output-format json` envelope (`{ result, ... }`), a bare
 * candidate array/object, and JSON embedded in surrounding prose or a ```json fence. Malformed
 * candidates are dropped; unparseable output yields `[]`.
 */
export function parseBrainResponse(stdout: string): BrainCandidate[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // Unwrap the headless JSON envelope first, if present, and reason over its result text.
  const envelope = tryParse(trimmed);
  if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
    const o = envelope as Record<string, unknown>;
    // A schema-validated run would surface candidates here directly.
    const structured = candidatesFrom(o.structured_output);
    if (structured && structured.length) return structured;
    if (typeof o.result === "string") return extractCandidates(o.result);
  }
  return extractCandidates(trimmed);
}

// ── The adapter ─────────────────────────────────────────────────────────────────

/** The one impure dependency: run `claude -p` with a prompt and return its raw stdout. */
export type ClaudeRunner = (prompt: string) => Promise<string>;

/**
 * The real Brain: render the context, run Claude once, parse the candidates back. The runner is
 * injected so the adapter is fully testable without a subprocess (mirrors the injected `fetch` in
 * `HttpPricingAdapter`). `brainAdapterFromEnv` supplies the real `claude -p` runner in production.
 */
export class ClaudeBrainAdapter implements BrainAdapter {
  constructor(private readonly run: ClaudeRunner) {}

  async propose(ctx: BrainContext): Promise<BrainCandidate[]> {
    const stdout = await this.run(buildBrainPrompt(ctx));
    return parseBrainResponse(stdout);
  }
}

// ── Construction from env (the real `claude -p` runner) ─────────────────────────────

export interface ClaudeRunnerConfig {
  /** Pro/Max subscription token (ADR-0001), passed to the child as CLAUDE_CODE_OAUTH_TOKEN. */
  oauthToken?: string;
  /** The claude binary to run; override for a non-PATH install. */
  claudeBin?: string;
  /** Model alias/full name (`opus`/`sonnet`/`claude-opus-4-8`/…). Omit to use the CLI default. */
  model?: string;
  /** Hard ceiling on a single Run's Brain call; a hung subprocess is killed and rejects. */
  timeoutMs?: number;
}

/** Injectable side-effects so the runner construction is testable (the spawn is the thin shell). */
export interface BrainDeps {
  /** Bypass the subprocess entirely (tests, or a future SDK-backed Brain). */
  runClaude?: ClaudeRunner;
  spawn?: typeof spawn;
}

/**
 * The ADR-0001 headless invocation flags (pure, so a test can assert them): print mode, JSON
 * envelope, a single bounded turn — and crucially never `--bare`. `--max-turns 1` keeps it a
 * single completion (no agentic loop / tool use) without needing a tool-allowlist flag, whose
 * empty-string form (`--tools ""`) this CLI rejects as a missing argument. The model alias
 * (`opus`/`sonnet`/…) is passed when configured. The prompt itself is fed on stdin (not here) so
 * a multi-KB brief has no argv-length/escaping limit.
 */
export function claudeArgs(model?: string): string[] {
  const args = ["-p", "--output-format", "json", "--max-turns", "1"];
  if (model) args.push("--model", model);
  return args;
}

/** Build the real `claude -p` runner: spawn, pipe the prompt on stdin, return the result envelope. */
export function makeClaudeRunner(config: ClaudeRunnerConfig = {}, deps: BrainDeps = {}): ClaudeRunner {
  const spawnImpl = deps.spawn ?? spawn;
  const bin = config.claudeBin ?? DEFAULT_CLAUDE_BIN;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      // Pass the OAuth token through explicitly; leave the rest of the env intact. Never --bare.
      const env = { ...process.env };
      if (config.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;

      const child = spawnImpl(bin, claudeArgs(config.model), {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // claude is `claude.cmd` on Windows; shell:true lets the PATH/.cmd resolution work.
        shell: process.platform === "win32",
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.on("data", (d) => (stdout += String(d)));
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`claude -p exited ${code}: ${stderr.trim() || "(no stderr)"}`));
      });

      child.stdin?.end(prompt);
    });
}

/**
 * Build the production Brain from environment config. Auth is `CLAUDE_CODE_OAUTH_TOKEN` (ADR-0001);
 * `VINYL_CLAUDE_BIN` overrides the binary for a non-PATH install. A `deps.runClaude` short-circuits
 * the subprocess (used in tests and wherever a Run wants to inject a different Brain transport).
 */
export function brainAdapterFromEnv(
  env: Record<string, string | undefined> = process.env,
  deps: BrainDeps = {},
): ClaudeBrainAdapter {
  const runner =
    deps.runClaude ??
    makeClaudeRunner(
      {
        oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || undefined,
        claudeBin: env.VINYL_CLAUDE_BIN?.trim() || undefined,
        model: env.VINYL_BRAIN_MODEL?.trim() || DEFAULT_BRAIN_MODEL,
      },
      deps,
    );
  return new ClaudeBrainAdapter(runner);
}
