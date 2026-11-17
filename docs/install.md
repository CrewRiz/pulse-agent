# Install

pulse-agent needs Node 18 or later.

```sh
npm install -g github:CrewRiz/pulse-agent
pulse-agent --help
```

That installs from the public repository. The command is `pulse-agent`. The source is at [github.com/CrewRiz/pulse-agent](https://github.com/CrewRiz/pulse-agent), MIT licensed.

## Set up a project

Go to the project you want it to work on and run:

```sh
cd your-project
pulse-agent init
```

`init` asks no questions. It does four things, in this order, and prints each one:

- Looks for a model server already running on this machine: Ollama, LM Studio, llama.cpp, an MLX server or vLLM.
- Asks each model to call a tool. A model that answers in prose cannot drive an agent, so it is passed over.
- Finds the project's own test command: `npm test`, pytest, `cargo test`, `go test` or `make test`.
- Saves the result in `.pulse-agent/config.json`.

Then give it work:

```sh
pulse-agent run "fix the failing date parser test"
```

## If init finds nothing

No server running: start one (see [Local models](local-models.md)) and run `pulse-agent init` again.

No test command: pass one on each run with `--verify "<command>"`, or add `"verify"` to `.pulse-agent/config.json`. Without a check, a run is recorded as unverified and teaches the agent nothing.

## Uninstall

```sh
npm uninstall -g memory-pulse-agent
```

(`memory-pulse-agent` is the package's name once installed.)

The agent's state lives in each project, in `.memory-pulse/` and `.pulse-agent/`. Delete those folders to remove it.
