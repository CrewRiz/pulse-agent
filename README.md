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
npm install -g github:CrewRiz/pulse-agent     # the command is pulse-agent
```

Node 18 or later. The package is named `memory-pulse-agent`, because the npm
name `pulse-agent` belongs to another project.

## Set up a project

```sh
cd your-project
pulse-agent init
```

`init` asks no questions. It finds a model server already running on your
machine (Ollama, LM Studio, llama.cpp, an MLX server or vLLM), asks each model
to call a tool and keeps the first one that really does, finds the project's
own test command, and saves `.pulse-agent/config.json`. Nothing leaves your
machine.

Then:

```sh
pulse-agent run "fix the failing date parser test"
pulse-agent team "fix the failing date parser test"     # builder, then a reviewer that cannot write
```

For a hosted endpoint instead:

```sh
export PULSE_AGENT_API_KEY=...
pulse-agent init --base-url https://your-endpoint/v1 --model <model>
```

Exit code 0 means the check passed (or no check was configured), 2 means the
check failed, 1 means an error. Full documentation is in `docs/`.

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
| `builder` (default) | read, list, search, write and edit files, run commands, delegate, propose a skill |
| `scout` | list, search and read files |
| `evaluator` | read files, run the `--verify` command and nothing else |

```sh
pulse-agent run "review the date parser change" --role evaluator --verify "npm test"
```

## Approvals and trust

By default the agent may edit files inside the project and run your check.
Anything else that changes something needs your permission: any other shell
command, and every connector call.

```sh
pulse-agent allow "run:npm run build"     # allow one command for this project
pulse-agent allow "run:git *"             # a wildcard never covers a command that chains, pipes or redirects
pulse-agent run "..." --yes               # allow everything for one run
```

In a chat on a terminal you are asked instead: yes once, always, or no. With
nobody to ask, the answer is no, and the model is told why. A deny rule in the
project's config beats any allow. The question is put to you; a model's text or
a tool's output can never answer it.

A project can ship things that act on your machine or steer the model:
`AGENTS.md` and `CLAUDE.md`, skills in `.agents/skills` or `.claude/skills`,
a pre-tool hook, connectors, and approval rules in its config. None of it is
loaded until you run `pulse-agent trust` in that project. Trust is recorded
outside the project, so a checkout cannot trust itself.

Ctrl+C during a chat turn stops the turn, kills the running command and
everything it started, and keeps the session.

## Chat, sessions and context that is never lost

```sh
pulse-agent chat                         # replies stream as they are written
pulse-agent sessions                     # list this project's sessions
pulse-agent chat --resume <session>      # continue one in a new process
```

A model's window is bounded and a long session is not. When a conversation
passes its budget, what leaves the window is not handed to a summary and
forgotten. It is written word for word into a hash-chained store on disk, the
window keeps a record of what was done and where each result went, and one tool,
`recall_context`, brings any of it back exactly, by id or by a search.

It happens in stages. First, with no model call, old bulky tool results are
swapped for a one-line pointer. Only if that is not enough do old turns leave
whole, replaced by a note: the model's own notes when there is enough to
summarise, and always a plain record of the work done. Each time, a checkpoint
row goes into the ledger with the store's head hash. A changed store entry
fails its hash and is never returned.

## Token cost

Three things keep a run cheap, and the run tells you what it spent.

**Scripts over tools.** For work that needs several tool calls or large results,
the model can write a short script that calls the tools, works on what they
return, and prints only what it needs. The files it read never enter the
conversation. The script runs in a separate Node process under Node's
permission model: it cannot write files, read outside its own folder, start
processes or use the network. Its only way to act is to ask for a tool call,
and each one passes the same role limits and approval rules as a call the model
makes directly. If that confinement cannot be confirmed on your Node version,
the tool is not offered. `--no-script` turns it off.

**Connector tools on demand.** A few connector tools are sent with each request
as usual. A large set (more than 12 tools, or more than about 6,000 characters
of definitions) is not: the model gets `find_tool` and `call_tool` instead, and
looks up what it needs.

**Small results by default.** `read_file` returns a long file in pages, with
the line range and the offset for the next one. `search` and `list_files` stop
at about 6,000 characters and say how much was left out. A subagent's report is
held to the same size. Inside a script the tools return whole results, because
the script does the filtering.

**A stable request prefix.** The tool list is the same bytes on every request
of a session, and connector tools are sent in name order, so a provider's
prompt cache keeps hitting. Cached tokens are counted when the endpoint reports
them.

**Context that moves out, losslessly.** See the section on chat and sessions.

Each run prints the tokens the endpoint reported, and `--json` carries them.
One measurement, one run each way, on 17 November 2026 with Llama 3.3 70B on a
hosted endpoint: finding the largest value across eight files took 7,119 input
tokens over 4 model calls without scripts and 3,923 over 2 calls with them,
with the same correct answer. A builder's own tool definitions and system
prompt come to about 4,700 characters per request.

## Background commands, forks and scripts

The builder can start a long-running command (a dev server, a watcher) with
`run_background`, keep working, read what it has printed since the last look,
and stop it. Starting one needs the same approval as any command. At most four
run at once, and whatever is still running when the run or the chat ends is
stopped.

`pulse-agent sessions fork <session> --at <turn>` branches a session at an
earlier turn. It branches the conversation; it does not restore files.

`pulse-agent run "<task>" --json` prints one JSON object per line (each tool
call, each check, and a final `end` object with the verdict), for scripts and
CI.

## Subagents

The builder can hand a self-contained piece of work to a subagent with the
`delegate` tool. A child starts with a fresh context, gets only its role's
tools, cannot delegate further, writes nothing to the ledger, and is bound by
the same approval rules as its parent. Several delegations in one turn run at
the same time.

| Role | What it can do |
|---|---|
| `scout` | list, search and read files |
| `evaluator` | read files and run your check |
| `worker` | edit files and run commands, in its own git worktree |

A worker never edits the shared checkout. It works in a worktree cut from the
project's current commit, so two workers cannot collide. When it finishes, its
changes come back as a patch with a work id, and nothing is applied until the
builder calls `apply_work`. A patch that no longer fits is refused whole. At
most three workers run at once. Outside a git repository, or with no commit, a
worker is refused; it is not run in place.

## Connectors

A connector is any Model Context Protocol (MCP) server, started as a local
command or reached over HTTP, the open standard other
agents use for tools, so servers written for them work here unchanged. Add them
to `.pulse-agent/config.json` under `mcpServers`, in the same shape other agents
use, optionally with a `tools` allowlist, and check them with
`pulse-agent connectors`. The builder can call them; the evaluator cannot. A
connector runs with your user's permissions and is not confined to the project.

## Team runs

`pulse-agent team "<task>"` runs the builder, then an evaluator that did not
build the change, has no tool that writes, can run only your check, and is not
shown the builder's own account of its work. The check is still the verdict. The
review is kept in the ledger.

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
  a command that is allowed to run has your user's permissions. Use a container
  or a throwaway checkout for work you do not trust.
- One provider shape: OpenAI-compatible chat completions with tool calls.
- There is no sandbox. A command the agent is allowed to run has your user's
  permissions. The approval rules decide which commands run, not what they can
  reach.
- Approval prompts appear only in a chat on a terminal. Everywhere else an
  unlisted command is refused.
- Under a very small context budget a model can lose track of its own work.
  The default budget is 200,000 characters; the record of work done is kept in
  the window to prevent repeats.
- A connector is not confined to the project. Configure only servers you trust.
- `init` checks that a model can call a tool at all. That is not a test of
  competence: a 1.5 billion parameter model passed it and then failed a real
  task by answering in prose. Such a run ends with a failed check and nothing
  is learned.
- The packer keeps about 70 MB of model state in memory while it runs, and a packed file should be unpacked by the
  same major Node version that packed it; if the arithmetic ever differs, unpack fails on the checksum.
- This version has been run end to end against one hosted model on four small
  tasks: a bug fix, a chat with context recall, a run with the learned read on,
  a bug fix delegated to a worker in a worktree and applied, and a search
  across files with and without scripts. Onboarding has
  been run against one live local model server. Everything else in its 86 tests
  runs against scripted models, fake model servers and a fake MCP server:
  connectors, team runs, background commands and the terminal approval prompt
  have not been exercised by a live model. Treat it as new.

## Development

```sh
npm install
npm test
```

MIT licence.
