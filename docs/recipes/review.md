# Cross-model review (`fleet_review`)

Sends one diff, read-only and inline, to 2–3 cheap reviewers in parallel and returns only the findings at least
`minAgree` (default 2) of them agree on. The point is Claude's context: a review comes back as about 1 KB.

```
fleet_review {repo, range: "HEAD~1..HEAD"}          # or diffFile, or branch (+ base)
fleet_review {…, spec: "what the change must do", private: true, minAgree: 2, reviewers: ["agy", "local"]}
```

- Default reviewers: `agy:gemini-3.8-flash-high`, `grok`, `api:free` (profile `review.reviewers`).
- **Private** (`private: true`, or the repo/diff paths match a `privatePaths` glob in the profile): the free
  OpenRouter reviewer is replaced by `local` (Lok's Qwen on this machine), or dropped when local isn't ready.
- Output: `reviewers` with each status, and `agreed` findings `{file, line, severity, claim, failure, by}`.
  Everything else (single-reviewer findings, raw answers) stays in the run folder; `fleet_transcript` shows it.
  If fewer than `minAgree` reviewers answered, the result says so and lists their findings as `unconfirmed`.
- Diffs over 60 000 characters are refused: review per file or a smaller range.

## Traps found while building it (2026-10-21)

1. **Reviewers misnumber lines.** A free model reported lines 9 and 16 for bugs at 4 and 9 (it counted from the top
   of the diff). Findings are anchored to the diff's changed lines by content before merging (`reportedLine` keeps
   the original).
2. **Same bug, different words.** Two models described the off-by-one as "off-by-one loop condition" and "the loop now
   includes i === items.length". Matching is mostly by place (same file, line within 2), not wording.
3. **One reviewer, one vote.** A group never holds two findings from the same reviewer, or a reviewer's own findings
   can chain unrelated bugs into one group.
4. **agy reads files if invited.** Its usual no-shell preamble tells it to use its file-reading tool, so with the diff
   inline it tried and was denied. Review prompts say "Everything you need is in this message. Do not use any tools."
5. **Weak models echo the schema.** Given a JSON Schema, a free model returned the schema. Reviewers get a one-line
   description and one example object instead.
6. **Quota ≠ failure.** Grok's "402 Payment Required: Grok Build usage balance exhausted" shows as `limit`.

Real reviewer outputs: `test/fixtures/review-real/`.
