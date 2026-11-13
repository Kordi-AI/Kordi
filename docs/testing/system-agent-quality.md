# System agent quality test

Compare models before changing the System agent's provider, and compare Grounding match instructions before changing them. The test replays a fixed set of synthetic group conversations, Grounding card builds and Grounding match runs through the real System agent path, scores what the model did, and compares a baseline run with candidate runs.

It calls a real model, so it is opt-in and never part of default CI. A scripted stub model keeps the harness itself tested in CI.

## What is real

Each System agent fixture is written into a disposable PostgreSQL database, created for that run, through the server's own stores. Then, for every pass:

1. The server batches eligible member messages until the group is quiet, or responds to a direct mention after the sweep debounce. It builds a bounded snapshot and lets the model decide whether the group needs help.
2. The runner's System agent loop (the `omp` or `rust` engine) calls the configured model with the production prompt. On conversation and direct request runs, the model chooses one action in a JSON reply.
3. A scheduling proposal from the JSON reply or from the `plan_card` tool goes to the same server handler, which applies the production validation and member permissions.
4. The server completes the run: it posts the reply, refreshes cards, and records reminders.

Grounding fixtures use the server's redaction, card-build instructions and reply parsing, and the runner's Common ground completion on the same service credential. They need no database.

Grounding match fixtures queue what a real match run queues: the match instructions and one viewer's card with up to eight other cards. The runner's Common ground completion answers, and the server's own code reads the reply: it drops topic pairs that are not on the cards, scores each finding from both sides, and decides whether the finding reads the same to either person, which is when the server also stores it for the other person. They need no database.

All people, cards, messages and evidence are fictional (`example.test` identities). Never add real cards, real people or production data to a fixture.

## Fixtures

Fixtures live in `bridges/system-agent-eval/fixtures`. List them with:

```bash
cargo run -p kordi-system-agent-eval -- list
```

They cover a vote that is then decided, a deal confirmed across two passes, a reschedule, a cancellation, a decline that must not cancel, the 24-hour and 2-hour reminders, an @mention question, conversations where the System agent must stay silent, a conversation that tempts it to repeat itself, a timezone case, a plan with no time yet, two Grounding card builds, and two Grounding match suites.

`--kind system-agent`, `--kind grounding` or `--kind grounding-match` lists or runs one kind, also together with `--only`.

Each pass states its expected outcome: whether the System agent replies or stays silent, which `plan_card` actions are allowed and required, and the expected card (state, time, place, who is going). Dates are templates resolved at replay time, for example `{{d+3:long}}` or `{{now+20h}}`; see `src/fixture.rs`.

### Grounding match suites

A match suite is one file under `fixtures/grounding-match` that the loader expands into runs, so nobody maintains generated files:

- `lab.json`: the 30 people of the Common ground lab (`experiments/common-ground-lab/fixtures/personas.json`) with their cards, the lab's 64 labelled pairs (`strong`, `weak` or `none`, and `overlap`, `paraphrase`, `complement`, `hard_negative` or `unrelated`), its two rooms of 12, and gold pairs for every strong pair. A test fails when the people, cards, labelled pairs or rooms differ from the lab file, which stays the single source of these people.
- `names.json`: eight people whose display names stress the rule that a finding reads the same to either person: a full name, first names that are common English words (Will, May, Art, Grace), Ray with the topic "Ray tracing for games", a name in Greek script and a single-word name.

Runs are batched the way the server batches them. In each room, every member is the viewer once, matched with the rest of the room in member order, eight people at a time (`match-lab-r1-p01-1`, `match-lab-r1-p01-2`). Labelled pairs that no room run covers then run in both directions, grouped by viewer (`match-lab-pairs-p01-1`).

Gold pairs justify a strong label with labels exactly as the cards write them, under the server's rules: a shared pair takes a working on or interests topic from each side, and a trade `[giver, topic, receiver topic]` takes one of the giver's can help topics for one of the receiver's working on, interests or looking for topics. The stub's reply is written from them at load time: the gold pairs with neutral reasons, and empty lists for everyone else.

## Run a comparison

1. Point the harness at a PostgreSQL server on this machine whose role may create databases. The database in the URL is used only to connect for administration and is never written to: every run creates its own `kordi_eval_<pid>_<time>_<random>` database on that server, applies the migrations there, replays into it, and drops it when the run ends, also after an error, a panic, or Ctrl-C (`DROP DATABASE ... WITH (FORCE)` on PostgreSQL 13 and later). The harness refuses any server that is not a Unix socket, `localhost`, or a loopback address, judged from the parsed connection settings (URL host, `host`/`hostaddr` parameters, `PGHOST`). A loopback port can be a tunnel to a shared server, so never point it at a shared development tunnel even though nothing outside the run's own database is touched.

   ```bash
   export KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres
   ```

2. Configure the baseline provider with the same environment variables a deployment uses, then run:

   ```bash
   cargo run --release -p kordi-system-agent-eval -- run --label baseline
   ```

3. Change the provider settings to the candidate and run again with another label:

   ```bash
   cargo run --release -p kordi-system-agent-eval -- run --label candidate
   ```

4. Compare. Reports are written to `target/system-agent-eval/<label>.json` unless `--out` is given.

   ```bash
   cargo run --release -p kordi-system-agent-eval -- compare target/system-agent-eval/baseline.json target/system-agent-eval/candidate.json --markdown comparison.md --json comparison.json
   ```

Use `--only <id>,<id>` or `--kind <kind>` to replay a subset. Model output varies between runs, so run each configuration more than once before deciding: `--repeat N` replays every selected fixture N times in one report, for fixtures that need no database (narrow a run with `--kind grounding` or `--kind grounding-match`). `compare` warns, on stderr and at the top of the comparison, when a candidate ran a different set of fixtures than the baseline, and lists the added and removed fixture ids; totals are then not comparable.

### Compare match instructions

`--match-prompt current` (the default) uses the instructions the server queues today; `--match-prompt baseline` uses the wording from before findings were kept for both people, stored verbatim in `src/match_system_baseline.txt`. Each report records which one it used and the SHA-256 of its text.

```bash
cargo run --release -p kordi-system-agent-eval -- run --label match-baseline --kind grounding-match --repeat 3 --match-prompt baseline
cargo run --release -p kordi-system-agent-eval -- run --label match-current --kind grounding-match --repeat 3
cargo run --release -p kordi-system-agent-eval -- compare target/system-agent-eval/match-baseline.json target/system-agent-eval/match-current.json
```

A live run uses the System agent provider settings from the environment. Production queues Grounding runs on the resource pool's Grounding route, which can name another model, so to measure Grounding as deployed, set the variables below to the provider and model of that route.

## Settings

Everything comes from environment variables; nothing is read from files and no key belongs in the repository.

| Variable | Purpose |
|---|---|
| `KORDI_SYSTEM_AGENT_PROVIDER` | `openai`, `openai-compatible`, or `vertex-ai` |
| `KORDI_SYSTEM_AGENT_OPENAI_API_KEY`, `KORDI_SYSTEM_AGENT_OPENAI_BASE_URL`, `KORDI_SYSTEM_AGENT_OPENAI_MODEL` | OpenAI and OpenAI-compatible providers |
| `KORDI_SYSTEM_AGENT_VERTEX_MODEL`, `KORDI_SERVICE_VERTEX_PROJECT`, `KORDI_SERVICE_VERTEX_LOCATION` | Vertex AI, with workload identity in `GOOGLE_APPLICATION_CREDENTIALS` |
| `KORDI_SYSTEM_AGENT_PERSONA` | The deployment's persona text; without it, debug builds use the development persona |
| `KORDI_CLOUD_AGENT_ENGINE` | `omp` (the runner's default; needs an absolute `KORDI_OMP_WORKER_ENTRY` pointing to the packaged `kordi-omp` worker, see [OMP runtime](../development/omp-runtime.md)) or `rust` |
| `KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL` | The disposable database |
| `KORDI_SYSTEM_AGENT_EVAL_INPUT_USD_PER_MTOK`, `KORDI_SYSTEM_AGENT_EVAL_OUTPUT_USD_PER_MTOK` | Optional prices for the cost estimate |

The provider fallback (`KORDI_SYSTEM_AGENT_FALLBACK_*`) must be unset, so each run measures one model.

### OpenAI-compatible gateways

Any endpoint that serves OpenAI chat completions over HTTPS works, for example OpenRouter:

```bash
export KORDI_SYSTEM_AGENT_PROVIDER=openai-compatible
export KORDI_SYSTEM_AGENT_OPENAI_BASE_URL=https://openrouter.ai/api/v1
export KORDI_SYSTEM_AGENT_OPENAI_MODEL=anthropic/claude-sonnet-4.5
export KORDI_SYSTEM_AGENT_OPENAI_API_KEY=...   # from your shell or secret store, never a file in the repository
```

The base URL must be `https`, and the runner refuses local or private-network endpoints. Reports name the provider as `openai` with the gateway's host. The model ID reaches the gateway exactly as configured, as it does in production, so a gateway model such as `openai/gpt-5.1` keeps its prefix. A leading `openai/` is dropped only when the base URL is the OpenAI API itself.

## Metrics

| Metric | Meaning |
|---|---|
| Plan card correctness | The card ends in the expected state, time, place and attendance, and required actions succeeded |
| Silence when no intervention is useful | No message where none is expected |
| Facilitator workflow correctness | The expected decision, Memory, or assignment card is published |
| Replies when one is due | A message where one is expected, mentioning what it must |
| Valid tool calls | Every `plan_card` call is allowed for that pass and accepted by the server |
| No repeated messages | No message repeats an earlier System agent message |
| Grounding cards | The reply parses into a card with enough cited topics, the expected topics, and none of the excluded ones |
| Grounding matches | The reply parses into a match list; a strong overlap or paraphrase pair keeps a shared pair, a strong complement keeps a trade, and a hard negative or unrelated person keeps nothing (weak pairs have no check) |
| Runs completed | The run finished without a provider error or timeout |
| Passes the sweep skipped correctly | Passes with no model call; the same for every provider |

### Numbers

Match runs also produce numbers over each whole suite, named `<suite>/<number>`, such as `match-lab/auc_strong_vs_none`. Each is measured once per repeat; the report keeps the value of every repeat, their mean and the observations behind them, so noise is visible. `compare` prints them side by side with the difference from the baseline. A run that failed contributes no findings.

| Number | Meaning |
|---|---|
| `auc_strong_vs_none`, `auc_strong_weak_vs_none` | How well the score separates strong (or strong and weak) pairs from pairs labelled none, over labelled pairs in each direction; equal scores count half |
| `top3_hit_rate`, `top3_none_count` | For each room viewer with a strong partner in the room, all batches together: whether the three highest scores above zero include a strong partner, and how many people labelled none they include |
| `strong_score_at_least_50`, `_70`, `_85` | Share of strong pairs, in each direction, scoring at least that much |
| `dropped_pair_rate` | Share of the pairs the reply proposed that the server dropped, for labels not on the cards, the wrong list or side, repeats, or more than three per list |
| `either_person_rate` | Share of findings with any kept pair that read the same to either person, so the server stores them for both |
| `either_person_second_person_rate`, `either_person_name_rate` | Share of those findings kept for the viewer only because a reason or the next step says "you" or names one of the two people |
| `direction_shared_jaccard` | For pairs seen in both directions where either kept a shared pair: overlap of the shared topic pairs after swapping sides |
| `direction_score_difference` | For pairs seen in both directions where either scored above zero: mean absolute difference of the two scores |

Each report also records latency per run (p50, p95, max), tokens per run as the provider reports them, and an estimated cost when prices are set. When some runs made model calls without reporting token counts, the cost covers only the runs that did and is marked partial (`costPartial` in JSON, `≥ $X (partial: n of m runs reported usage)` in text). Provider error text in reports is cut to 300 characters, and anything that looks like a credential (bearer tokens, `sk-` keys, Google keys and access tokens, JWTs, `key=` query parameters, long hex or base64 strings) is replaced with `[redacted]`. The comparison lists every check that passed in the baseline and failed in a candidate, and the reverse.

## In CI

`pnpm check:server` runs the unit tests, the Grounding fixtures and the Grounding match suites with the stub model. `pnpm check:migrations` replays every System agent fixture with the stub model on its PostgreSQL database and checks that the scoring catches a misbehaving model.

To run the stub suite locally, including the database tests (each creates and drops its own database on the server):

```bash
cargo run -p kordi-system-agent-eval -- run --stub --label stub
KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
  cargo test -p kordi-system-agent-eval -- --include-ignored --test-threads=1
```

## Add a fixture

Add a JSON file under `fixtures/system-agent` or `fixtures/grounding`. Every pass needs a `stub` script with the replies a good model would give, so the stub suite proves the expectations are reachable through the real server. History messages must be more than 30 minutes old and turn messages 1 to 29 minutes old, so the timeline stays history, then the seeded card, then the turn.

### Add a person or a labelled pair

Every person is fictional. Never copy a real card, a real person's name or production data into a suite.

- For the lab suite, change `experiments/common-ground-lab/fixtures/personas.json` first, then make the same change in `fixtures/grounding-match/lab.json`; the drift test compares the two.
- A person needs an `id`, a display `name` and the four lists `workingOn`, `interests`, `canHelp` and `lookingFor`. Add them to a room's `members` to match them with that room.
- A labelled pair names `a` and `b`, a `label`, a `kind` and a short `why`. A strong pair also needs gold pairs: `shared` as `[a's topic, b's topic]` and `trades` as `[giver, topic, receiver topic]`, at least one shared pair for an overlap or paraphrase and at least one trade for a complement. Only strong pairs carry gold pairs. The loader rejects gold pairs that the server would drop.
- A pair labelled `none` must be `hard_negative` or `unrelated`; a strong pair cannot be either. Loading fails on unknown people or a repeated pair.
