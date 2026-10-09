# temper-pr-queue

A Claude Code mod for reviewing a batch of open pull requests on
[temperlang/temper](https://github.com/temperlang/temper). It was written for
the 50 or so fix PRs from `notactuallytreyanastasio` (plus #507, the Elixir
backend), and works for any author.

## Install

At a Claude Code prompt in a terminal, add the marketplace, then install
from it:

```
/plugin marketplace add notactuallytreyanastasio/temper-pr-queue
/plugin install temper-pr-queue@temper-pr-queue
```

Or from a shell:

```
claude plugin marketplace add notactuallytreyanastasio/temper-pr-queue
claude plugin install temper-pr-queue@temper-pr-queue
```

`claude plugin list` should then show `temper-pr-queue@temper-pr-queue` as
enabled, and a new session has `/pr-queue` and `/pr-review`. It needs `gh`,
logged in, on your `PATH`.

The mod is a function-hooks module (`hooks/register.tsx`), which is newer
than other plugin kinds. It was built and tested on Claude Code 2.1.296. On
an older version the install can succeed while the commands never appear;
`claude --version` tells you which you have, and `claude update` moves you
forward.

If `/pr-queue` answers that gh was not found, Claude Code was started
without `gh` on its `PATH` (the desktop app and IDEs do not read your shell
profile). The mod also looks in `/opt/homebrew/bin`, `/usr/local/bin` and
`/usr/bin`; otherwise start `claude` from a terminal where `gh --version`
works. After an update, `/plugin marketplace update temper-pr-queue` and a
new session pick up the new version.

## What it adds

`/pr-queue [login]` fetches the author's open PRs on temperlang/temper and
opens a pane that groups them by the subsystem prefix in their titles
(`frontend`, `be-rust`, `be-py`, ...). Each row shows the issues the PR fixes,
its size, whether GitHub can merge it, its review state, and the other queued
PRs that edit the same source files. The command's reply lists a suggested
merge order.

`/pr-review <number>` asks Claude to review one PR for merging. The prompt
it queues has Claude read the PR and the issues it fixes, check it out in a
worktree next to yours, build it and origin/main, and run the PR's
reproduction case from
[temper-issue-repros](https://github.com/notactuallytreyanastasio/temper-issue-repros)
with both. It then runs the tests of the modules the diff touches, confirms
the regression test fails with the fix reverted, tries a program or two
beside the fixed shape, and says whether merge order matters given the PRs
that share its files. It ends with a verdict and the evidence. It does not
comment, approve or push on GitHub unless you ask it to.

The `pr_queue` tool gives Claude the same data plus the merge order, so a
question like "which of these can I merge without rebasing anything?" gets
answered from the queue rather than from guesses.

## How overlap and order are worked out

Two PRs overlap when both change the same file. Files that every PR adding a
functional test regenerates (`functional-test-matrix.md`, `FunctionalTests.kt`,
`FunctionalTestSuiteI.kt`, `FunctionalTestStatus.kt`, the suite's
`config.temper.md`, the docs snippet hashes) are left out: merging two such PRs
means rerunning the generator, not resolving a conflict.

A PR over 2,000 changed lines that carries copies of other PRs' changes, as
#507 does, is listed as "also in #507" on those rows instead of as an overlap.
Merging one of the small PRs shrinks #507's diff.

The suggested order puts independent, mergeable, small PRs first, then PRs
that share files (fewest overlaps and smallest first, so each later one has
less to rebase over), then anything GitHub reports as conflicting, then PRs
over 2,000 lines, then drafts.

## What it does not do

It reads GitHub's `mergeable` per PR against main. Two PRs that each merge
cleanly on their own can still conflict with each other; the overlap column
is the warning for that, not a guarantee either way.

The review prompt is a checklist for Claude, not a script. How well a review
goes depends on the PR and on the machine: building every backend needs the
JDKs, Python, Rust, Node, a C++ toolchain, Lua and Elixir that the temper repo
expects.

The repository and the default author are constants at the top of
`hooks/register.tsx`.

## Developing it

```
claude --plugin-dir /path/to/temper-pr-queue
claude plugin validate /path/to/temper-pr-queue
claude plugin test /path/to/temper-pr-queue
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude
Code writes when it loads the mod from a folder; run `tsc -p .` after that.
