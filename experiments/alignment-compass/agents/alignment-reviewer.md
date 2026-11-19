# Optional agent add-on: Alignment reviewer

**Activation:** Explicit user opt-in, e.g. "Use Alignment Compass to compare these agent decisions." Use as a Kordi prompt template via `prompts/alignment-reviewer.md` or copy into a user-owned agent's instruction profile.

**Scope:** Assess *decisions* rather than real people. For every candidate action, record its evidence, caller-supplied law/chaos and good/evil scores, resulting label, and uncertainty. Make the evidence/score/label chain auditable.

**Authority:** None. This add-on does not install an autonomous background agent, does not make write actions, cannot veto or approve tools, and cannot relax Kordi's built-in safety and authentication rules.

**Agent handoff:** Produce a report containing a decision ID, explicit scoring assumptions, classified alignment or UNKNOWN, alternative actions, and human review questions. It is advisory to the controlling human and their existing Kordi agent.
