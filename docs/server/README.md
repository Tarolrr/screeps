# Local standalone server

The server installation and mutable state remain separate from this strategy repository. The existing installation is `~/screeps` with Node 22 at `~/.local/node22/bin`; game HTTP/WebSocket listens on 21025 and the administrative CLI on localhost 21026. Its `.screepsrc`, `db.json`, `logs/`, `storage.sock`, `assets/` and `node_modules/` are live runtime state, not copies to use here. The private `.screepsrc` at this repository root is a reference copy only; the server reads its own configuration from its working directory. Never commit either configuration.

`package.json`, `package-lock.json`, and `mods.json` in this directory are snapshots of the existing server installation, not the strategy's package manifest or a replacement installation. Paths in `mods.json` are relative to the server directory. The server's source instructions were in `~/screeps/AGENTS.md`; upstream API documentation is at https://docs.screeps.com/api/.

With Node 22 available on PATH, run an already configured server from its own directory with `cd ~/screeps && npx screeps start`. Inspect logs in `~/screeps/logs/`. Do not start a second instance against the same database. The CLI grants direct administrative access and should remain local. Steam authentication requires the private key in the server config; never put it in templates or logs.

Existing configuration used one runner, two runner threads and one processor. Before running any e2e test, inspect the test room and coordinate exclusive use of the server: tests write to its database and some change global tick duration. See [e2e instructions](../../e2e/README.md).
