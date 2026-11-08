# ⚓ Porto

Porto reserves TCP port blocks for Git checkouts and worktrees.

## 🚀 Start

Install Node.js 24 or later and Git 2.36 or later.

```sh
pnpm add -D @b12k/porto
pnpm exec porto --vars API_PORT --env
```

Porto writes `API_PORT` to `.env`. Run the same command again to reuse the block.

| Worktree | Block | Ports       |
| -------- | ----: | ----------- |
| Main     |     0 | 10000–10009 |
| Feature  |     1 | 10010–10019 |

## 🖥️ Commands

Run each command with `pnpm exec porto`. `reserve` is the default command.

| Command   | Action                                                    |
| --------- | --------------------------------------------------------- |
| `reserve` | Reserve a block and print its index or variables.         |
| `current` | Show the blocks for this checkout.                        |
| `stats`   | Show all reservations for this repository.                |
| `release` | Release this checkout's blocks when their ports are free. |
| `cleanup` | Remove expired reservations when their ports are free.    |

| `reserve` option                        | Action                                                       |
| --------------------------------------- | ------------------------------------------------------------ |
| `--start <port>`                        | Set the first port of the range. Default `10000`.            |
| `--host <host>`                         | Check this host for busy ports. Default local addresses.     |
| `--size <count>`                        | Set the ports per block. Default `10`.                       |
| `--idle <minutes>`                      | Set the idle time limit. Default `60`.                       |
| `--keep` / `--no-keep`                  | Turn idle cleanup off or on for the block.                   |
| `--vars <entries>` / `--no-vars`        | Set or clear the variable list.                              |
| `--env` / `--no-env`                    | Turn env file output on or off. Default off. File `.env`.    |
| `--env-file <file>`                     | Set the env file path and turn on env output.                |
| `--json-file <file>` / `--no-json-file` | Set or clear the JSON output file.                           |
| `--json`                                | Print JSON to stdout. Also works with `current` and `stats`. |

Use `-h` or `--help` for help. Use `-V` or `--version` for the version.

Separate `--vars` entries with `;`. Use `NAME` for a port or `NAME:template` for text. Templates accept `{{block}}` and `{{port}}`.

With no variables, `--env` writes `PORTO_BLOCK`.

## ⚙️ Config

Create `porto.config.ts` or `porto.config.js` in your checkout. Porto searches from the current directory to the checkout root. If both files are in one directory, Porto uses the TypeScript file.

CLI options override config values. Config values override defaults.

Set `host` in config or use `--host` to check a specific address. Porto saves it for `release` and `cleanup`.

```ts
import { defineConfig } from '@b12k/porto';

export default defineConfig({
  envFile: '.env.local',
  vars: ['API_PORT', { WEB_URL: (_block, port) => `http://localhost:${port}` }],
  onReserved(block, ports) {
    console.error(`Block ${block.index} has ports ${ports.join(', ')}`);
  },
});
```

Relative paths in config start at the config directory. Relative paths in flags start at the current directory.

Each variable selects a port by position. A function receives the block index, port, and zero-based variable index.

A hook receives the block and its assigned ports. `onReserved` runs after file output. `onReleased` runs once per freed block. Porto runs release hooks in parallel.

## 📦 API

```js
import { reserve } from '@b12k/porto';

const block = await reserve({ vars: ['API_PORT'] });
const apiPort = block.getPort();
```

The API also provides `current`, `stats`, `release`, and `cleanup`.

Porto stores reservations in `<git-common-dir>/porto-registry.json`.
