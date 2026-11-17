# Contributing to pulse-agent

Thanks for wanting to help. This project has one idea: an agent should improve
only on evidence. The rules for changing it follow from that.

## Before you write code

Open an issue first for anything larger than a small fix. Say what you want to
change and what you would measure to show it works. A change nobody can check
will not be merged, however good it looks.

## The rules for a pull request

1. **One change per pull request.** A fix and a refactor are two pull requests.
2. **The test comes first.** Add a test that fails without your change and
   passes with it. Say in the description what the failure was.
3. **`npm test` passes** on Node 18, 20 and 22. CI runs all three.
4. **A gate needs a mutant.** If your change is a check, a limit or a refusal
   (a role's tool list, the workspace boundary, the ledger guard, the rule that
   only a passing check keeps a skill), break it on purpose and confirm a test
   fails. Name the mutant in the description.
5. **Numbers carry their source.** A claim like "smaller" or "faster" needs the
   input, the size of the input, and the command that produced the figure. One
   run on one machine is reported as that.
6. **No new runtime dependency** without an issue that agrees to it. The
   package has one, and that is part of why it is easy to audit.
7. **The limits stay written down.** If your change adds a limit or removes
   one, update the Limits section of the README in the same pull request.

## What will not be merged

- Anything that lets the model decide its own verdict, write its own lessons
  without a passing check, or use a skill no person accepted.
- Anything that widens a role's tools by default, or lets a path leave the
  workspace.
- A connector or provider that sends a project's files or ledger anywhere by
  default. Sending is always opt-in and always documented.
- Code copied from another project without its licence allowing it and without
  attribution in the file.

## Connectors and providers

A connector is an MCP server, so most integrations need no code here at all:
add the server to `.pulse-agent/config.json`. If you want to document one,
add it to `docs/connectors.md` with the command, the tools you allow, and
what it can reach.

A new model provider is welcome when an endpoint cannot be reached through the
OpenAI-compatible shape. It lives in `lib/`, is a function
`({ messages, tools }) -> { content, tool_calls }`, and is tested against a
local fake server, never a live API.

## Commit messages

Say what changed and what you measured. Mention the failing test you started
from. Sign your commits off (`git commit -s`): by doing so you state that you
wrote the change or have the right to submit it under the MIT licence.

## Security

Do not open a public issue for a vulnerability. See `SECURITY.md`.

## Conduct

See `CODE_OF_CONDUCT.md`. In short: be exact, be kind, and argue with
measurements.
