<p align="center">
  <img src="./porto.png" alt="Porto banner with a tree formed from Ethernet cables" />
</p>

# 🌳 :porto

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
| `--silent` / `--no-silent`              | Hide or show the reservation result on stdout.               |

Use `-h` or `--help` for help. Use `-V` or `--version` for the version.

Separate `--vars` entries with `;`. Use `NAME` for a port or `NAME:template` for text. Templates accept `{{block}}` and `{{port}}`.

With no variables, `--env` writes `PORTO_BLOCK`.

## ⚙️ Config

The CLI loads config for `reserve` and `release`. Create `porto.config.ts` or `porto.config.js` in your checkout. Porto searches from the current directory to the checkout root. If both files are in one directory, Porto uses the TypeScript file.

CLI options override config values. Config values override defaults.

```ts
import { defineConfig } from '@b12k/porto';

export default defineConfig({
  start: 10_000,
  size: 10,
  host: '127.0.0.1',
  idleTtlMinutes: 60,
  keep: false,
  env: true,
  envFile: '.env.local',
  jsonFile: 'ports.json',
  silent: false,
  vars: ['PORT', (_block, port) => ({ PORT_2: port, HOST_NAME: `https://localhost:${port}` }), 'DB_PORT'],
  onReserved(block, ports) {
    console.error(`Reserved block ${block.index} with ports ${ports.join(', ')}`);
  },
  onReleased(block, ports) {
    console.error(`Released block ${block.index} with ports ${ports.join(', ')}`);
  },
});
```

All properties are optional.

| Property         | Default                | Effect                                                                                       |
| ---------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| `start`          | `10000`                | Set the first port of the candidate range.                                                   |
| `size`           | `10`                   | Set the number of ports per block.                                                           |
| `host`           | Local addresses        | Check a specific host for busy ports. Porto saves the host for `release` and `cleanup`.      |
| `idleTtlMinutes` | `60`                   | Set the idle time limit in minutes. A new `reserve` call refreshes the timer.                |
| `keep`           | `false` for new blocks | Keep a block during idle cleanup. Omit to keep its current setting. Set `false` to clear it. |
| `env`            | `false`                | Write variables to an env file. With no variables, write `PORTO_BLOCK`.                      |
| `envFile`        | `.env`                 | Set the env file path. An explicit path enables `env` unless you set `env: false`.           |
| `jsonFile`       | `false`                | Save variables or block details to a JSON file. Use a path to enable it.                     |
| `silent`         | `false`                | Hide the `reserve` result on stdout. Porto still writes requested files and reports errors.  |
| `vars`           | Unset                  | Assign one port per entry. Use a name for a port number or a function for several values.    |
| `onReserved`     | Unset                  | Run after Porto saves the block and writes the requested files.                              |
| `onReleased`     | Unset                  | Run once per block freed by `release`.                                                       |

Relative paths in config start at the config directory. Relative paths in flags start at the current directory.

A `vars` function receives `(blockIndex, port, entryIndex)`, where `entryIndex` starts at zero. Return an object with string or number values. In the example, `PORT_2` and `HOST_NAME` use the same port.

Both hooks receive `(block, ports)`, where `ports` lists the ports assigned to that block. Hooks can return a promise. Porto runs release hooks in parallel.

## 📦 API

Run the API inside a Git checkout. It uses the options you pass in code and the built-in defaults.

### Get ports by offset

```js
import { reserve } from '@b12k/porto';

const block = await reserve();
const firstPort = block.getPort();
const secondPort = block.getPort(1);
```

`reserve()` returns `index`, `start`, `end`, `getPort(offset = 0)`, `ports`, and `vars`. The bounds are inclusive. Offsets start at zero and must fit inside the block.

### Get ports by name

```js
import { reserve } from '@b12k/porto';

const block = await reserve({ start: 10_000, size: 5, vars: ['PORT', 'API_PORT'] });
const { PORT, API_PORT } = block.vars;
const DB_PORT = block.getPort(2); // 10002 if the first block is free
```

TypeScript infers `PORT` and `API_PORT` as `number`. `block.vars` contains this call's named values and defaults to `{}`. `block.ports` lists the ports assigned through `vars` across calls. `getPort()` reads a port by offset.

### Share a port between variables

```js
import { reserve } from '@b12k/porto';

const block = await reserve({
  start: 10_000,
  size: 2,
  host: '127.0.0.1',
  idleTtlMinutes: 30,
  keep: true,
  vars: [
    'PORT',
    (_block, port) => ({
      API_PORT: port,
      API_URL: `http://localhost:${port}`,
      HEALTH_PORT: port,
      HEALTH_URL: `http://localhost:${port}/health`,
    }),
  ],
});
const { API_PORT, API_URL } = block.vars;
```

`reserve()` accepts `start`, `size`, `host`, `idleTtlMinutes`, `keep`, and `vars`. All six options are optional and use the defaults in the config table.

Each entry in `vars` uses one port. The example returns five named values from two entries. Five separate entries with `size: 2` throw `PortoError` with code `mappingInvalid` before Porto saves a reservation.

### Read and release reservations

```js
import { cleanup, current, release, stats } from '@b12k/porto';

const blocks = await current(); // Blocks for this checkout
const reservations = await stats(); // All reservations for this repository
const released = await release(); // Release this checkout's blocks if their ports are free
const expired = await cleanup(); // Release expired blocks if their ports are free
```

`release()` throws `BusyPortsError` if a port is in use. Its `ports` property lists the blocked ports.

Porto stores reservations in `<git-common-dir>/porto-registry.json`.
