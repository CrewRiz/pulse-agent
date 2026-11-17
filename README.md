# pulse-agent

A coding agent that improves only on evidence.

It works on a task in your project with a small set of tools, on any model that
speaks the OpenAI chat-completions format: a local one on your own machine, or a
hosted one. Its memory is a [memory-pulse](https://www.npmjs.com/package/memory-pulse)
ledger kept in the project.

Most self-improving agents grade their own work and write their own lessons.
This one does neither. A command you choose decides whether a task succeeded,
and nothing the agent learns is kept unless that command passed.

## Install

```sh
npm install -g memory-pulse-agent     # the command is pulse-agent
```

Node 18 or later. The npm name `pulse-agent` belongs to another project, so the
package is `memory-pulse-agent`.

## Run it

With a local model (nothing leaves your machine):

```sh
ollama serve                                   # or any OpenAI-compatible server
cd your-project
pulse-agent run "fix the failing date parser test" --model <your model> --verify "npm test"
```

With a hosted endpoint:

```sh
export PULSE_AGENT_BASE_URL=https://your-endpoint/v1
export PULSE_AGENT_API_KEY=...
pulse-agent run "fix the failing date parser test" --model <model> --verify "npm test"
```

The model needs to support tool calls. Exit code 0 means the check passed (or no
check was given), 2 means the check failed, 1 means an error.

## How it improves

Three rules, each enforced in code and each with a test.

**The check decides.** `--verify` is a command you write. When the model says it
is done, pulse-agent runs the command. Exit 0 is a pass. Anything else goes back
to the model with the output, up to `--max-rounds` times. The model's own claim
of success is never the verdict.

**A lesson needs a failure and a pass.** When a check fails and then passes, the
ledger gets one row: what the check said when it failed, and which files changed
before it passed. Later runs in the same project start with those rows. A run
with no check, or one that never passed, teaches nothing.

**A skill needs a pass and a person.** The model can propose a reusable
procedure. The proposal is deleted if the check fails. If the check passes it is
held, and the model never sees it again until you accept it:

```sh
pulse-agent skills                      # what is waiting
pulse-agent skills show <name>
pulse-agent skills accept <name>        # or: reject <name>
```

## Memory

The ledger is `.memory-pulse/events.jsonl` in the project. It does two more
things during a run.

It guards writes. If a correction in the ledger withdrew a value (a price, a
name, a claim), a write or edit that puts the value back is refused, and the
refusal names the correction. Record one with
`npx memory-pulse remember <cause> <effect> --kind correction --withdrawn "<old>" --replacement "<new>"`.

It checks for repeats. Before the first step, the task is compared with the
ledger. Rows that describe the same thing are shown to the model, and rows that
record a closed or failed attempt are marked. This match is on words, so it can
miss a repeat that is phrased differently.

## The learned read

The two checks above match words. memory-pulse's engine goes further: it learns
from the ledger's own vocabulary which corrections bear on a task, including
ones your wording never names. pulse-agent asks it before each run when a key is
set:

```sh
export MEMORY_PULSE_KEY=...        # from your memory-pulse account
pulse-agent run "..." --verify "npm test"
```

Using it sends the ledger's rows to the engine. Without a key nothing leaves
your machine, and `--no-learned` turns it off for one run. If the engine cannot
be reached, the run goes on with the local checks and says so.

## Roles

A role is a brief and a list of tools. The list is enforced where tools run, so
a model cannot argue its way past it.

| Role | Tools |
|---|---|
| `builder` (default) | read, write and edit files, run commands, propose a skill |
| `evaluator` | read files, run the `--verify` command and nothing else |

```sh
pulse-agent run "review the date parser change" --role evaluator --verify "npm test"
```

## Keeping state

```sh
pulse-agent state export            # .pulse-agent/state/<time>.rainz
pulse-agent state verify <file>
pulse-agent state import <file>     # in another checkout or on another machine
pulse-agent sync                    # commit ledger, skills and state to git; push if a remote exists
```

`state export` packs the ledger into a `.rain` capsule, memory-pulse's state
format: every row with its hash chain, verified before it is packed. The capsule
is then compressed with a packer built for this kind of text, a context-mixing
coder in the PAQ family. `import` restores or fast-forwards a ledger from a file
and refuses one that is damaged or whose history diverged from yours.

Measured on one real ledger of 4,236 rows (4.78 MB): the packer produced
1.40 MB, against 1.49 MB for brotli at its maximum setting and 1.90 MB for
gzip -9. It is slow by comparison: about 9 seconds to pack and 17 to unpack on a
laptop. The original bytes' SHA-256 is stored in the file and checked on
unpack, so a damaged file fails and never returns wrong data.

`sync` stages only the ledger and the `.pulse-agent` directory. Use a private
repository: a ledger holds your project's history.

## Limits

- **`run` is a real shell.** File tools cannot leave the project directory, but
  a command the model runs has your user's permissions. Use a container or a
  throwaway checkout for work you do not trust, and prefer the evaluator role
  when you only want a review.
- One provider shape: OpenAI-compatible chat completions with tool calls.
- A small model may answer in prose and never call a tool. The run then ends
  with a failed check and nothing is learned.
- The packer keeps about 70 MB of model state in memory while it runs, and a packed file should be unpacked by the
  same major Node version that packed it; if the arithmetic ever differs, unpack fails on the checksum.
- This version has been run end to end on two small tasks against one hosted
  model, and against scripted models in its 27 tests. In the live run with the
  learned read on, the engine answered and named no correction on a 7-row
  ledger. Treat it as new.

## Development

```sh
npm install
npm test
```

MIT licence.
