# D&D alignment extension example

An optional Kordi agent-layer plugin for **fictional character role-play and entertainment**. It supplies twelve original fantasy scenarios and transparent, deterministic scoring across the familiar law/chaos and good/evil axes. It is not a clinical, psychological, or real-world moral assessment. Players, not this tool, decide their characters' alignment.

This example uses the existing CommonJS plugin factory, `registerTool`, and `registerCommand` APIs in `agent/crates/plugin-host/js/host.js`. It does not modify the host, register event hooks, inspect history, or load by default.

## Load locally

Requirements: a Kordi CLI build from this repository with extension support and Node.js 22 or later on its `PATH`. No npm dependencies, TypeScript loader, network service, or production backend are needed by this plugin.

From the repository root, load just the entry point for one CLI session:

```sh
kordi -e ./agent/examples/dnd-alignment/extensions/index.cjs
```

Or install the package into a chosen project's local Kordi settings (this is opt-in and changes that project's settings):

```sh
kordi install --local ./agent/examples/dnd-alignment
kordi list --local
```

Use `kordi remove --local ./agent/examples/dnd-alignment` from the same project to remove the package. Alternatively stop using `-e` for a one-session load. Keep the package's `extensions/` and `lib/` directories together; copying only `index.cjs` will not work.

These commands target Kordi's **agent CLI extension layer**. They do not imply that the desktop or cloud agent offers an extension installer or exposes this tool in group chats. No desktop UI or production session integration is included. The automated integration test uses the shipped Node plugin host; a native CLI session and desktop end-to-end flow have not been manually validated.

## Play through the slash command

```text
/alignment
/alignment explain
/alignment score A B C A B C A B C A B C
```

`/alignment` (also `questions` or `help`) prints every question, its three choices, and each choice's score. Submit twelve space-separated letters in displayed order (`o1` through `o6`, then `m1` through `m6`). Letters are case-insensitive for the command. The example submission above produces **Lawful Good** with +12 on each axis. A missing, extra, or invalid answer produces no alignment. Every run is independent; there is no saved quiz state to reset.

## Play through the agent tool

1. Ask the agent to call `dnd_alignment` with `{"action":"questionnaire"}`.
2. Answer as your fictional character, without sharing sensitive personal information.
3. Ask the agent to submit all twelve explicit choices using `action: "score"` and an `answers` array. Each item has exactly `questionId` and uppercase `choice` (`A`, `B`, or `C`). For example, the first item might be `{"questionId":"o1","choice":"A"}`; a one-item submission is deliberately rejected.
4. Inspect the returned alignment, both raw and normalized axis totals, per-question contributions, and disclaimer.

Answer order does not matter for the tool because question IDs are explicit. Unknown IDs, duplicates, incomplete submissions, unknown fields, and invalid choices are rejected. Do not ask the agent to guess answers from a real person's messages or assign alignments to other group members.

## Scoring contract, version 1.0.0

- Six **order** questions measure preference for structure versus autonomy in fictional situations. Positive means Lawful; negative means Chaotic. They do not measure kindness or equate lawfulness with goodness.
- Six **morality** questions contrast care at personal cost, reciprocal/self-protective choices, and deliberate exploitation or harm. Positive means Good; negative means Evil in the fantasy-game vocabulary only.
- Each choice affects **one axis only** by `-2`, `0`, or `+2`. Choice positions vary. There are no hidden weights or model-generated scores.
- Each raw total ranges from `-12` to `+12`. Normalized total is `raw / 12`, from `-1` to `+1`; it is not a probability or confidence score.
- A total **at least +4** gets its positive label; **at most -4** gets its negative label. Totals strictly between those boundaries are Neutral. Integer totals from -3 through +3 are in the neutral band, though this questionnaire produces only even totals.
- Combine the labels into the nine alignments; Neutral/Neutral is called **True Neutral**.
- Opposing answers cancel, including exact ties. A neutral result can mean balanced opposing choices rather than indifference. No partial-result or missing-answer imputation is used.
- The threshold and weights are game-design choices, not validated psychometrics. Labels are suggestions for a fictional character, never a diagnosis, a verdict about the player, or evidence for consequential decisions.

## Privacy and permissions

The plugin does not read files or sessions, persist answers, contact services, request UI permissions, or send messages. Its answers exist only within the current call and returned result. **Kordi may still retain commands and tool results in the session transcript, and answers passed through an agent may be sent to its configured model provider.** This is not a promise of offline or private chat execution. Use invented characters and avoid sensitive data.

## Tests

From the repository root:

```sh
node --test scripts/dnd-alignment-extension.test.mjs
```

This runs scoring/registration tests and starts the real plugin host as a subprocess, verifies registration, and sends JSON-RPC questionnaire, score, invalid-input, and slash-command requests. The same file is included by the existing `pnpm test:scripts` CI command.

Package-only tests, without the repository host integration:

```sh
cd agent/examples/dnd-alignment
node --test test/*.test.cjs
```

Coverage includes all nine labels, inclusive thresholds, neutral boundaries, opposing-answer cancellation, all 729 answer combinations for each axis independently, normalization, per-answer accounting, defensive copies, and input failures. No test calls a model or a production server.

## Context and authorship

The following were supplied as conceptual background, **not as questionnaire text or scoring algorithms to copy**:

- <https://easydamus.com/alignmenttest.html>
- <https://www.wikihow.com/Moral-alignment-test>
- <https://en.wikipedia.org/wiki/Alignment_(Dungeons_%26_Dragons)>

All scenarios and scoring logic in this example are original to this contribution and are covered by the repository's MIT license. This is an unofficial fan-oriented example, not an official Dungeons & Dragons product or a reproduction of any linked test.
