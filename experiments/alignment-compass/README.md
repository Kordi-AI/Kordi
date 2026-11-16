# Alignment Compass core tool

Opt-in, dependency-free deterministic scoring of caller-supplied fictional or agent-decision scores. No moral inference, real-person classification, networking, persistence, or authorization changes. Missing scores or evidence return UNKNOWN, not True Neutral.

Run `node --test experiments/alignment-compass/test/core.test.cjs experiments/alignment-compass/test/stress.test.cjs`. Covers nine labels, inclusive thresholds, invalid inputs, abstention, and 20,000 seeded synthetic decisions.

This component is the shared scoring implementation, not a registered runtime tool by itself. The companion plugin PR registers `alignment_compass` and `/alignment`; skill and agent instructions are separate review units. Install the complete package only after all required components merge.

Independent Dungeons & Dragons-inspired narrative taxonomy; not affiliated with its publisher. No third-party prose or assets. MIT project license applies.
