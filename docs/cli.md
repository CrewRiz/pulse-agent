# Commands

| Command | What it does |
|---|---|
| `pulse-agent init` | Set this project up: find a local model that calls tools, find the test command, save the config. |
| `pulse-agent run "<task>"` | Work on a task. The check decides the verdict. |
| `pulse-agent team "<task>"` | The builder works, then an evaluator that cannot write reviews the change. |
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
| `--no-learned` | Do not ask the memory-pulse engine, even with a key set. |

## Environment

| Variable | Meaning |
|---|---|
| `PULSE_AGENT_MODEL` | Model name. |
| `PULSE_AGENT_BASE_URL` | Model endpoint. |
| `PULSE_AGENT_API_KEY` | Key for the endpoint, if it needs one. |
| `MEMORY_PULSE_KEY` | Turns on the learned read. Sends the ledger's rows to the engine. |

## Exit codes

0: the check passed, or no check was configured. 2: the check failed. 1: an error.

## Limits

The `run` tool is a real shell with your user's permissions. File tools cannot leave the project folder; commands can. Use a container or a disposable checkout for work you do not trust.
