import { describe, it, expect } from "vitest";
import {
  ClaudeBrainAdapter,
  brainAdapterFromEnv,
  buildBrainPrompt,
  claudeArgs,
  parseBrainResponse,
} from "./brain";
import type { BrainContext } from "./types";

/**
 * Exercises the real Brain adapter at its seam: the pure prompt builder, the tolerant response
 * parser, the ADR-0001 invocation flags, and the adapter wired to an *injected* `claude` runner —
 * no real subprocess in tests (the runner is the thin shell, like the injected `fetch` in pricing).
 */

const CTX: BrainContext = {
  owned: [
    {
      artist: "A Tribe Called Quest",
      title: "The Low End Theory",
      genres: ["Hip Hop"],
      styles: ["Jazzy Hip-Hop"],
      rating: 5,
      notes: ["the bassline on Verses from the Abstract"],
    },
    { artist: "Madvillain", title: "Madvillainy" },
  ],
  rejectedKeys: ["sun ra::space is the place"],
  chaosDial: { complete: 1, adjacent: 2, stretch: 1 },
};

describe("buildBrainPrompt", () => {
  const prompt = buildBrainPrompt(CTX);

  it("renders the owned set as taste evidence (artist, title, genres, rating, notes)", () => {
    expect(prompt).toContain("A Tribe Called Quest");
    expect(prompt).toContain("The Low End Theory");
    expect(prompt).toContain("Hip Hop");
    expect(prompt).toContain("the bassline on Verses from the Abstract");
    // rating surfaced as a learning signal, not just ownership
    expect(prompt).toMatch(/5/);
  });

  it("surfaces the rejected keys so the Brain doesn't re-suggest them", () => {
    expect(prompt).toContain("sun ra::space is the place");
  });

  it("names the three lanes and the chaos-dial weighting", () => {
    expect(prompt).toContain("complete");
    expect(prompt).toContain("adjacent");
    expect(prompt).toContain("stretch");
  });

  it("asks for JSON candidates", () => {
    expect(prompt.toLowerCase()).toContain("json");
  });
});

describe("parseBrainResponse", () => {
  const good = [
    { artist: "Pharoah Sanders", title: "Karma", lane: "stretch", why: "spiritual jazz one lane out" },
    { artist: "Gang Starr", title: "Moment of Truth", lane: "adjacent", why: "boom-bap neighbour", discogsReleaseId: 12345 },
  ];

  it("parses the --output-format json envelope (candidates in the result text)", () => {
    const envelope = JSON.stringify({
      result: "Here are my picks:\n```json\n" + JSON.stringify({ candidates: good }) + "\n```\n",
      session_id: "abc",
    });
    const out = parseBrainResponse(envelope);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ artist: "Pharoah Sanders", lane: "stretch" });
    expect(out[1]?.discogsReleaseId).toBe(12345);
  });

  it("parses a bare JSON array of candidates", () => {
    expect(parseBrainResponse(JSON.stringify(good))).toHaveLength(2);
  });

  it("parses a { candidates: [...] } object directly", () => {
    expect(parseBrainResponse(JSON.stringify({ candidates: good }))).toHaveLength(2);
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const text = `I'd suggest the following.\n${JSON.stringify(good)}\nHope that helps!`;
    expect(parseBrainResponse(text)).toHaveLength(2);
  });

  it("drops malformed candidates (bad lane / missing fields) rather than throwing", () => {
    const mixed = [
      { artist: "Valid", title: "Record", lane: "complete", why: "ok" },
      { artist: "No Lane", title: "X", lane: "sideways", why: "bad lane" },
      { artist: "Missing why", title: "Y", lane: "adjacent" },
      { title: "No artist", lane: "stretch", why: "z" },
    ];
    const out = parseBrainResponse(JSON.stringify(mixed));
    expect(out).toHaveLength(1);
    expect(out[0]?.artist).toBe("Valid");
  });

  it("returns [] for unparseable / empty output", () => {
    expect(parseBrainResponse("the model said no")).toEqual([]);
    expect(parseBrainResponse("")).toEqual([]);
    expect(parseBrainResponse(JSON.stringify({ result: "no json here" }))).toEqual([]);
  });
});

describe("claudeArgs (ADR-0001 invocation)", () => {
  const args = claudeArgs();

  it("runs headless print mode with machine-parseable JSON output", () => {
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
  });

  it("bounds the run to a single completion", () => {
    const i = args.indexOf("--max-turns");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("1");
  });

  it("never passes --bare (ADR-0001: it bypasses the OAuth subscription token)", () => {
    expect(args).not.toContain("--bare");
  });
});

describe("ClaudeBrainAdapter", () => {
  it("builds the prompt, runs claude, and returns parsed candidates", async () => {
    const seen: string[] = [];
    const runner = async (prompt: string) => {
      seen.push(prompt);
      return JSON.stringify({
        candidates: [{ artist: "Alice Coltrane", title: "Ptah, the El Daoud", lane: "stretch", why: "deep" }],
      });
    };
    const brain = new ClaudeBrainAdapter(runner);
    const out = await brain.propose(CTX);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("A Tribe Called Quest"); // the prompt carried the taste context
    expect(out).toEqual([
      { artist: "Alice Coltrane", title: "Ptah, the El Daoud", lane: "stretch", why: "deep" },
    ]);
  });

  it("returns [] when the runner yields nothing usable (a bad Run shouldn't crash the pick)", async () => {
    const brain = new ClaudeBrainAdapter(async () => "claude had a bad day");
    expect(await brain.propose(CTX)).toEqual([]);
  });
});

describe("brainAdapterFromEnv", () => {
  it("returns a Brain adapter that uses an injected runner end-to-end", async () => {
    const brain = brainAdapterFromEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      { runClaude: async () => JSON.stringify([{ artist: "X", title: "Y", lane: "complete", why: "w" }]) },
    );
    const out = await brain.propose(CTX);
    expect(out).toEqual([{ artist: "X", title: "Y", lane: "complete", why: "w" }]);
  });
});
