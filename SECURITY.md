# Security

## Reporting a vulnerability

Write to hello@strategic-innovations.ai. Do not open a public issue. Say what
you found, how to reproduce it, and what it lets an attacker do. You will get a
reply saying whether it is accepted and what happens next.

## What to know before you rely on pulse-agent

- The `run` tool executes shell commands with your user's permissions. File
  tools are confined to the project directory; commands are not. Run untrusted
  tasks in a container or a disposable checkout.
- A connector (MCP server) runs as its own process with your permissions and is
  not confined to the project. Only configure servers you trust, and use the
  `tools` allowlist.
- A model can be steered by text it reads in files or tool output. The role
  limits, the workspace boundary and the ledger guard are enforced in code and
  do not depend on the model behaving, but they do not make `run` or a
  connector safe.
- With `MEMORY_PULSE_KEY` set, a run sends the ledger's rows to the memory-pulse
  engine. Without it, nothing is sent.

## In scope

A path that escapes the workspace through a file tool; a role calling a tool
outside its list; a skill reaching the model without a passing check and a
person's accept; a packed state file that unpacks to wrong bytes without an
error; the ledger guard being bypassed by a write or edit.
