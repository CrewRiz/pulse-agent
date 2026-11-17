# Local models

pulse-agent talks to any server that speaks the OpenAI chat-completions format with tool calls. Run one on your own machine and nothing leaves it.

## Ollama

```sh
ollama serve
ollama pull <a model that supports tool calls>
cd your-project && pulse-agent init
```

`init` finds Ollama at `http://127.0.0.1:11434/v1`.

## LM Studio, llama.cpp, MLX, vLLM

Start the server's OpenAI-compatible endpoint. `init` checks these addresses:

| Server | Address it checks |
|---|---|
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| llama.cpp or an MLX server | `http://127.0.0.1:8080/v1` |
| vLLM | `http://127.0.0.1:8000/v1` |

A server on another port:

```sh
pulse-agent init --base-url http://127.0.0.1:9000/v1
```

## Which model

The one requirement is that the model emits tool calls. `init` tests this for real: it offers the model one tool and asks it to call it. In our own test, a 1.5 billion parameter model answered in prose and failed that probe, and a 70 billion parameter model passed. Sizes in between vary by model and by server, so let `init` decide.

Name a model yourself with `pulse-agent init --model <name>`. If it does not call the tool, `init` says so and saves nothing.

## A hosted endpoint

```sh
export PULSE_AGENT_API_KEY=...
pulse-agent init --base-url https://your-endpoint/v1 --model <name>
```

The task, the files the agent reads and the tool results are then sent to that endpoint.
