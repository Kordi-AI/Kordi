---
name: alignment-compass
description: Advisory D&D-inspired nine-alignment analysis of explicitly scored fictional scenarios or agent decisions.
---

# Alignment Compass

Use only when the user explicitly asks for D&D-style alignment or decision trade-off analysis. Evaluate a *specific fictional scenario or agent decision*, never the identity, character, trustworthiness, or rights of a person.

## Method

1. Identify the decision, actor, available options, and verifiable evidence; omit sensitive data.
2. The caller must supply both scores: `lawChaos` in [-2, 2] (+2 rules/procedure; -2 improvisation/autonomy), and `goodEvil` in [-2, 2] (+2 care/collective benefit; -2 narrow self-interest/externalized harm). If missing, abstain (UNKNOWN). Do not present the scores as measured facts.
3. Call `alignment_compass` with `scope: "fictional"` or `scope: "agent_decision"` and `items` containing a non-sensitive `id`, both scores, and short evidence statements.
4. Distinguish observed evidence from assumptions, supplied scores, and the resulting label. Review trade-offs and possible disagreement instead of treating the label as a moral verdict.
5. Do not modify tools, permissions, system prompts, runtime modes, authentication, guardrails, memory, or communications. This skill is an interpretive lens, not an authorization layer.

## Example

```json
{
  "scope": "agent_decision",
  "items": [
    {
      "id": "ex-review-before-write",
      "lawChaos": 2,
      "goodEvil": 1,
      "evidence": ["The agent proposed changes and requested approval before applying them."]
    }
  ]
}
```

An empty evidence list or an incomplete score returns UNKNOWN. Neutral does not mean absence of evidence. Reports should state that the nine categories are inspired by the Dungeons & Dragons alignment system; this is an independent implementation and is not affiliated with its publisher.
