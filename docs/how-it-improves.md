# How it improves

Most self-improving agents grade their own work and write their own lessons. pulse-agent does neither. Three rules, each enforced in code and each covered by a test.

## The check decides

A check is a command that exits 0 when the work is right. Usually it is your test suite.

When the model says it is done, pulse-agent runs the check. Exit 0 is a pass. Anything else goes back to the model with the output, up to three times by default. What the model says about its own work never counts.

```sh
pulse-agent run "make the date parser accept ISO week dates" --verify "npm test"
```

Exit code 0 means the check passed, 2 means it failed, 1 means an error.

## A lesson needs a failure and a pass

When a check fails and later passes, the ledger gets one row: what the check said when it failed, and which files changed before it passed. Later runs in the same project start with those rows.

A run with no check, or one that never passed, teaches nothing.

```sh
pulse-agent lessons
```

## A skill needs a pass and a person

The model can propose a reusable procedure. If the check fails, the proposal is deleted. If it passes, the proposal is held and the model does not see it again until you accept it.

```sh
pulse-agent skills
pulse-agent skills show <name>
pulse-agent skills accept <name>
```

## A second reader

```sh
pulse-agent team "make the date parser accept ISO week dates"
```

The builder does the task. Then an evaluator reviews the change. The evaluator did not build it, has no tool that writes, can run only your check, and is not shown the builder's account of its own work. The check is still the verdict. The review goes in the ledger.

## What a run costs

Each run prints the tokens the model endpoint reported. Two things keep the number down. The model can write a short script that calls tools and prints only what it needs, so the files it read never enter the conversation; the script runs confined and can act only through the same tools and approval rules. And a large set of connector tools is searched on demand instead of being sent with every request.

## Memory that says no

The ledger is `.memory-pulse/events.jsonl`, a [memory-pulse](https://www.npmjs.com/package/memory-pulse) ledger.

If a correction in it withdrew a value, a write that puts the value back is refused and the refusal names the correction. Before each task, the ledger is searched for the same idea already tried, and rows that record a closed or failed attempt are marked for the model.

That search matches words. It can miss a repeat phrased differently. With a memory-pulse key set, each run also asks the engine's learned read, which sends the ledger's rows to the engine.
