# mend-patch

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/odockdai/mend-patch/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/odockdai/mend-patch/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** applies the edits AI models write to a tree of text files, in all four formats they write them: unified
diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON. It finds the
lines an edit names even when the model drifted their trailing whitespace or indentation (three matching tiers,
re-indenting new lines to the file's own indentation), keeps each file's CRLF or LF breaks and final newline, and
writes every change or none.

- One file, `main.ts`: Node 22 and its standard library, nothing to install.
- Format detection, or `--format=unified|search-replace|v4a|json`.
- `--check` reports exactly what a run would do and writes nothing; `--strict` matches lines exactly.
- Unsafe paths (absolute, `..`, backslashes) are refused before anything else about an edit is looked at.
- Every failed edit is reported, in patch order, and the tree is left untouched when any edit fails.

## Run it

```sh
node main.ts fix.patch            # apply a patch file in the current directory
node main.ts --check < fix.patch  # dry run from standard input
node check.ts practice.json       # the kit's practice checks
```

Output is one line per changed path (`A`, `D`, `M`, or `R old -> new`) and `ok: <n> files`; failures print
`error: <code> <path>` lines and `failed: <k> of <n> edits` with exit 1; usage, unreadable patch, unknown format and
parse errors exit 2.

---

<sub>Entered on [make.fun](https://make.fun/?ref=xawxgk7v&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
