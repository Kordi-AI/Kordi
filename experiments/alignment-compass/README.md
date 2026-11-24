# Alignment Compass for Kordi

A **zero-dependency**, opt-in package for evaluating specific fictional or agent decisions through the traditional nine Dungeons & Dragons-inspired alignments. It provides a JS extension tool, a `/alignment` command, a Kordi skill, an agent reviewer prompt template, and deterministic stress tests.

**Not a safety classifier or moral authority.** The caller supplies both axis scores and evidence. The package does not infer human traits, write to the network, load credentials, modify sessions, or authorize or block actions. Missing evidence or scores return **UNKNOWN**, not True Neutral.

## Architecture and install

Kordi's native package discovery reads the `kordi` manifest field in this directory's `package.json` and registers resources from `extensions/`, `skills/` and `prompts/`.

From a source-built Kordi CLI, in a separate disposable development workspace:

```sh
kordi install --local ./experiments/alignment-compass
kordi list --local
```

Alternatively load only the extension with `kordi -e ./experiments/alignment-compass/extensions/alignment-compass.cjs`. The optional `agents/alignment-reviewer.md` supplies an explicitly opt-in agent-instruction handoff; it is not installed as a background agent. Kordi also discovers `prompts/alignment-reviewer.md` as an agent reviewer template.

No production app session or backend is required to exercise this package. Do **not** test with the signed-in production Kordi app or connect to shared Kordi infrastructure.

## Call the tool

```json
{
  "scope": "agent_decision",
  "items": [
    {
      "id": "approval-before-write",
      "lawChaos": 2,
      "goodEvil": 1,
      "evidence": ["The agent requested user approval before changing files."]
    },
    {
      "id": "unverified-option",
      "lawChaos": 0,
      "evidence": []
    }
  ]
}
```

The first item returns Lawful Good; the second returns UNKNOWN. The `/alignment help` command describes the JSON interface; `/alignment <JSON>` scores the supplied payload.

## Scoring contract

| Axis | -2 | 0 | +2 |
| --- | --- | --- | --- |
| `lawChaos` | Chaotic (improvisation) | Neutral | Lawful (rules/procedure) |
| `goodEvil` | Evil (self-serving/harm externalized) | Neutral | Good (care/collective benefit) |

A score greater than or equal to +0.5 yields the positive axis, less than or equal to -0.5 the negative axis, and otherwise Neutral. Zero is a **scored neutral**; omitted values or empty evidence are **UNKNOWN**. When both axes are scored Neutral, the label is True Neutral. Labels are descriptions of explicitly supplied fictional decision scores and not scientific measures of morality. Evidence and labels are returned verbatim for review. Only synthetic or intentionally shared non-sensitive evidence should be submitted.

## Tests (isolated, offline)

```sh
node --test experiments/alignment-compass/test/*.test.cjs
node --test experiments/alignment-compass/test/stress.test.cjs
pnpm check:english
```

The integration test loads the actual `agent/crates/plugin-host/js/host.js` in a child Node process, checks tool/command registration, makes a real JSON-RPC call, rejects malformed data, and executes 150 concurrent synthetic requests. The stress test checks 20,000 seeded synthetic decisions for score preservation and all nine categories. Full desktop, mobile, live cloud, or production Kordi integration is **NOT_TESTED** by these tests. Never run load tests against `kordi.ai`.

## Attribution and scope

Inspired by the Dungeons & Dragons nine-alignment taxonomy; this implementation uses independent descriptions and is not affiliated with, endorsed by, or licensed from Wizards of the Coast. References: [overview](https://en.wikipedia.org/wiki/Alignment_(Dungeons_%26_Dragons)) and [alignment examples](https://easydamus.com/alignment.html). This package includes no third-party prose or images. MIT terms of the surrounding Kordi project apply to this contribution.

The installed ChatGPT GitHub connector can manage the fork and PR, but does not grant access to Kordi app sessions. A separate ChatGPT Kordi app connector was **not discovered** when this package was developed; no such connection is claimed.
