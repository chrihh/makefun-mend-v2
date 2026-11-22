[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/chrihh/makefun-mend-v2/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/chrihh/makefun-mend-v2/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend v2

mend is one patch tool for every AI edit format. It applies an edit an AI model wrote — a unified diff (line numbers may be wrong), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON — to a tree of text files, finding the named lines even when their whitespace or indentation drifted, and writes every change or none. Node 22, standard library only; `SPEC.md` is the full specification it implements.

## How it works

v2 is a pipeline. Four format readers each normalize their format into a small common edit IR (create / delete / move / splice / chunks / text-replace / insert) and never touch the file system. One anchor matcher finds old lines at the first of three fuzz tiers and rewrites replacements for that tier. One transactional applier runs the IR edits in patch order against a virtual tree — an in-memory overlay on the real directory — and flushes to disk only when every edit has succeeded, which is what makes a patch all-or-nothing.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=44n6pkpv&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
