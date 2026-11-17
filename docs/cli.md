# Commands

| Command | What it does |
|---|---|
| `pulse-agent init` | Set this project up: find a local model that calls tools, find the test command, save the config. |
| `pulse-agent run "<task>"` | Work on a task. The check decides the verdict. |
| `pulse-agent chat` | An interactive session. Replies stream; the conversation carries across turns. `--resume <session>` continues one. |
| `pulse-agent sessions` | List this project's sessions. `fork <session> --at <turn>` branches one; files are not restored. |
| `pulse-agent team "<task>"` | The builder works, then an evaluator that cannot write reviews the change. |
| `pulse-agent trust` | Load what this project ships: instruction files, skills, hooks, connectors, approval rules. `--revoke` undoes it. |
| `pulse-agent allow "<rule>"` | Allow something without being asked: `run:npm test`, `run:git *`, `edit:src/*`, `mcp:files__*`. |
| `pulse-agent skills` | List proposed and accepted skills. `show`, `accept`, `reject <name>`. |
| `pulse-agent lessons` | What verified runs taught. |
| `pulse-agent connectors` | Start each configured MCP server and list its tools. |
| `pulse-agent state export` | Pack the ledger into a compressed `.rain` capsule. Also `verify <file>` and `import <file>`. |
| `pulse-agent sync` | Commit the agent's state to git and push if a remote exists. |

## Options for run and team

| Option | Meaning |
|---|---|
| `--verify "<command>"` | The check. Exit 0 is a pass. Overrides the config. |
| `--role builder` or `evaluator` | `run` only. The evaluator reads and runs the check, and cannot write. |
| `--model <name>` | Overrides the config. |
| `--base-url <url>` | The model endpoint. |
| `--max-steps <n>` | Model turns allowed. Default 30. |
| `--max-rounds <n>` | Times the check may fail and go back to the model. Default 3. |
| `--eval-model <name>` | `team` only. A different model for the evaluator. |
| `--stream` | `run` and `team`: print the reply as it is written. `chat` always streams. |
| `--context-budget <n>` | Characters the conversation may hold before older material moves to the recoverable store. Default 200000. |
| `--yes` | Allow every edit, command and connector call for this run. Deny rules still apply. |
| `--json` | `run` and `team`: one JSON object per line, ending with an `end` object that carries the verdict. |
| `--no-learned` | Do not ask the memory-pulse engine, even with a key set. |

## Inside a chat

| Command | Meaning |
|---|---|
| `/session` | This session's name. |
| `/context` | How much has left the window and can be recalled. |
| `/check` | Run the check command now. |
| `/exit` | Leave. The session is saved. |

## Roles

| Role | Tools |
|---|---|
| `builder` | Read, list, search, write and edit files, run commands (also in the background), delegate, propose a skill, use connectors. |
| `scout` | List, search and read files. |
| `evaluator` | Read files and run your check. |
| `worker` | Edit files and run commands in its own git worktree. Its changes come back as a patch the builder applies with `apply_work`. |

The builder can delegate to a scout, an evaluator or a worker. A subagent starts with a fresh context, cannot delegate further, and is bound by the same approval rules. A worker needs a git repository with at least one commit; without one it is refused.

## Environment

| Variable | Meaning |
|---|---|
| `PULSE_AGENT_MODEL` | Model name. |
| `PULSE_AGENT_BASE_URL` | Model endpoint. |
| `PULSE_AGENT_API_KEY` | Key for the endpoint, if it needs one. |
| `MEMORY_PULSE_KEY` | Turns on the learned read. Sends the ledger's rows to the engine. |

## Exit codes

0: the check passed, or no check was configured. 2: the check failed. 1: an error.

## Approvals

By default the agent may edit files in the project and run your check. Any other command, and every connector call, needs a rule from `pulse-agent allow`, a yes from you in a chat, or `--yes`. With nobody to ask, the answer is no. A wildcard rule never covers a command that chains, pipes, substitutes or redirects.

## Trust

Instruction files (`AGENTS.md`, `CLAUDE.md`), skills in `.agents/skills` and `.claude/skills`, a pre-tool hook, connectors and approval rules in the project's config are loaded only after `pulse-agent trust`. Trust is recorded outside the project.

## Limits

There is no sandbox. A command that is allowed to run has your user's permissions. File tools cannot leave the project folder; commands can. Use a container or a disposable checkout for work you do not trust.
