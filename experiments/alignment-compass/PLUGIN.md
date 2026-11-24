# Alignment Compass plugin

Depends on the companion core-tool PR (see PR body). Merge the core first. This PR registers `alignment_compass` and `/alignment` through the existing CommonJS plugin host. It does not change default runtime behavior.

After the core merges, run `node --test experiments/alignment-compass/test/*.test.cjs`. Load the extension explicitly with `kordi -e ./experiments/alignment-compass/extensions/alignment-compass.cjs` in an isolated development workspace. Package discovery also declares the companion skill and prompt directories; those resources require their separate PRs. Do not claim complete package installation until the full set merges.

Input: `{ "scope": "fictional", "items": [{ "id": "unverified-option" }] }` returns UNKNOWN. Optional axis scores are numbers in [-2, 2]; evidence is at most five short non-sensitive statements. Both scores and nonempty evidence are needed for a label. Supplied scores are never inferred. No label changes permissions.

Host tests cover real JSON-RPC registration, tool and command execution, invalid data, 150 concurrent synthetic calls, advertised schema abstention, and timeout-safe child cleanup. No production sessions or network services are used. Full native CLI installation and desktop E2E remain NOT_TESTED.
