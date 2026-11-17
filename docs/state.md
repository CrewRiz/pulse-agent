# State

Everything the agent knows is in two folders in your project: `.memory-pulse/` (the ledger) and `.pulse-agent/` (config, skills, state files).

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
