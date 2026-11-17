# State

Everything the agent knows is in two folders in your project: `.memory-pulse/` (the ledger) and `.pulse-agent/` (config, skills, state files).

## Sessions and the recoverable store

Each chat or run is a session in `.pulse-agent/sessions/<name>/`. It holds two files: the live conversation, and `context.jsonl`, the store for everything that has left the model's window.

Nothing that leaves the window is lost. Old tool results and old turns are written to the store word for word, each entry hashed and chained to the one before. The window keeps a record of the work done and an id for each stored result. The model gets a `recall_context` tool that returns any entry exactly, by id or by a search. An entry that was changed on disk fails its hash and is not returned.

Each time material moves, a checkpoint row with the store's head hash goes into the ledger, so the ledger and any `.rain` capsule made from it record where every session stood.

## Export, verify, import

```sh
pulse-agent state export
pulse-agent state verify .pulse-agent/state/<file>.rainz
pulse-agent state import <file>.rainz
```

`export` writes the ledger as a `.rain` capsule, memory-pulse's state format: every row with its hash chain, checked before it is packed. The capsule is then compressed.

`import` restores a ledger into a project that has none, or brings one forward. It refuses a damaged file and a ledger whose history has diverged from the file's.

## The packer

State files are compressed by a packer built for this kind of text, a context-mixing coder in the PAQ family.

Measured on one real ledger of 4,236 rows (4.78 MB):

| Method | Size |
|---|---|
| pulse-agent packer | 1.40 MB |
| brotli, maximum setting | 1.49 MB |
| gzip -9 | 1.90 MB |

It is slow: about 9 seconds to pack that ledger and 17 to unpack, on a laptop. It holds about 70 MB in memory while it runs.

The SHA-256 of the original bytes is stored in the file and checked on unpack. A damaged file fails. It never returns wrong data.

## Keep it on GitHub

```sh
git remote add origin <your private repository>
pulse-agent sync
```

`sync` commits the ledger and the `.pulse-agent` folder and pushes. It stages nothing else. Use a private repository: a ledger holds your project's history.
