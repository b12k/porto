<p align="center">
  <img src="./porto.png" alt="Porto banner with a tree formed from Ethernet cables" />
</p>

# 🌳 Porto

💪 **Port reservations on steroids.**

Porto reserves a range of TCP ports, called a slot, for each Git worktree.
It checks for port conflicts and saves the slot for the next run.

🧹 **It can haz cleanups.** When you reserve ports, Porto removes expired slots if all their ports are free.

## 🚀 Install

**npm**

```sh
npm install -D @b12k/porto
```

**pnpm**

```sh
pnpm add -D @b12k/porto
```

**Yarn**

```sh
yarn add -D @b12k/porto
```

**Bun**

```sh
bun add --dev @b12k/porto
```

## Use Porto

- [CLI](#cli) - Pass options when you run `pnpm porto`.
- [Config](#config) - Save settings in `porto.config.ts` or `porto.config.js`.
- [API](#api) - Add `@b12k/porto` as a dependency and call `reserve()` from your code.

### CLI

```css
porto [reserve?] [options]
porto show [slot-number?] [--all?]
porto release [slot-number?] [--all?]
porto cleanup
```

#### Commands

| Command   | Action                                                                      |
| --------- | --------------------------------------------------------------------------- |
| `reserve` | _**(default)**_ Allocate a port slot and print its index or variables.      |
| `show`    | Show a slot. Use `--all` to show all slots.                                 |
| `release` | Release a slot. Use `--all` to release all slots when their ports are free. |
| `cleanup` | Remove expired slots when their ports are free.                             |

#### `reserve` options

| Option                                  | Default           | Action                                        |
| --------------------------------------- | ----------------- | --------------------------------------------- |
| `--start <port>`                        | `10000`           | Set the first port of the range.              |
| `--host <host>`                         | Local addresses   | Check this host for busy ports.               |
| `--size <count>`                        | `10`              | Set the number of ports per slot.             |
| `--idle <minutes>`                      | 60 minutes        | Set the idle time limit.                      |
| `--keep` / `--no-keep`                  | Off for new slots | Keep the slot during idle cleanup.            |
| `--vars <vars>` / `--no-vars`           | None              | Set or clear the variable list.               |
| `--env` / `--no-env`                    | Off               | Turn env file output on or off.               |
| `--env-file <file>`                     | `.env`            | Set the env file path and turn on env output. |
| `--json-file <file>` / `--no-json-file` | Off               | Set or clear the JSON output file.            |
| `--json`                                | Off               | Print JSON to stdout. Also works with `show`. |
| `--silent` / `--no-silent`              | Off               | Hide or show the slot result on stdout.       |

Use `-h` or `--help` for help. Use `-V` or `--version` for the version.

##### `--vars` template syntax

Use `;` to move to the next port and `|` to share the current port. Use `NAME` for a port number or `NAME=template` for text. Templates accept `{{slot}}` and `{{port}}`.

##### Write to files

```sh
pnpm porto --vars "CLIENT_PORT|HOST_URL=http://localhost:{{port}};API_PORT" --env-file .env.local --json-file env.json
```

Both files always include `PORTO_SLOT`, the slot index. If the first slot is free, Porto writes these files.

`.env.local`

```dotenv
CLIENT_PORT=10000
HOST_URL=http://localhost:10000
API_PORT=10001
PORTO_SLOT=0
```

`env.json`

```json
{ "CLIENT_PORT": 10000, "HOST_URL": "http://localhost:10000", "API_PORT": 10001, "PORTO_SLOT": 0 }
```

Run the same command again in this worktree to reuse its slot. A second worktree gets its own slot.

`--start` and `--size` are shared by all worktrees. Omit them to reuse the saved settings. Release all slots before changing them.

| Worktree | Slot | Ports       |
| -------- | ---: | ----------- |
| Main     |    0 | 10000-10009 |
| Feature  |    1 | 10010-10019 |

#### `show` and `release` options

| Argument or option | Default              | Action                                |
| ------------------ | -------------------- | ------------------------------------- |
| `[slot-number]`    | This worktree's slot | Select a slot by index.               |
| `--all`            | Off                  | Select all slots for this repository. |

Use a slot number or `--all`. If a port is busy, `release --all` keeps every slot.

### Config

The CLI loads config for `reserve` and `release`. Create `porto.config.ts` or `porto.config.js` in your worktree. Porto searches from the current directory to the worktree root. If both files are in one directory, Porto uses the TypeScript file.

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
  vars: ['PORT', (_slot, port) => ({ PORT_2: port, HOST_NAME: `https://localhost:${port}` }), 'DB_PORT'],
  onReserved(slot, ports) {
    console.error(`Reserved slot ${slot.index} with ports ${ports.join(', ')}`);
  },
  onReleased(slot, ports) {
    console.error(`Released slot ${slot.index} with ports ${ports.join(', ')}`);
  },
});
```

All properties are optional.

| Property         | Default               | Effect                                                                                      |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `start`          | `10000`               | Set the first port of the candidate range.                                                  |
| `size`           | `10`                  | Set the number of ports per slot.                                                           |
| `host`           | Local addresses       | Check a specific host for busy ports. Porto saves the host for `release` and `cleanup`.     |
| `idleTtlMinutes` | `60`                  | Set the idle time limit in minutes. A new `reserve` call refreshes the timer.               |
| `keep`           | `false` for new slots | Keep a slot during idle cleanup. Omit to keep its current setting. Set `false` to clear it. |
| `env`            | `false`               | Write variables and `PORTO_SLOT` to an env file.                                            |
| `envFile`        | `.env`                | Set the env file path. An explicit path enables `env` unless you set `env: false`.          |
| `jsonFile`       | `false`               | Save variables or slot details with `PORTO_SLOT` to a JSON file. Use a path to enable it.   |
| `silent`         | `false`               | Hide the `reserve` result on stdout. Porto still writes requested files and reports errors. |
| `vars`           | Unset                 | Assign one port per entry. Use a name for a port number or a function for several values.   |
| `onReserved`     | Unset                 | Run after Porto saves the slot and writes the requested files.                              |
| `onReleased`     | Unset                 | Run once per slot freed by `release`.                                                       |

Relative paths in config start at the config directory. Relative paths in flags start at the current directory.

A `vars` function receives `(slotIndex, port, entryIndex)`, where `entryIndex` starts at zero. Return an object with string or number values. In the example, `PORT_2` and `HOST_NAME` use the same port.

Both hooks receive `(slot, ports)`, where `ports` lists the ports assigned to that slot. Hooks can return a promise.

### API

Run the API inside a Git worktree.

#### Get ports by offset

```js
import { reserve } from '@b12k/porto';

const slot = await reserve();
const firstPort = slot.getPort();
const secondPort = slot.getPort(1);
```

`reserve()` returns the saved slot with `getPort(offset = 0)`. Offsets start at zero and must fit inside the slot.

`firstPort` and `lastPort` are the slot's inclusive bounds.

#### Get ports by name

```js
import { reserve } from '@b12k/porto';

const slot = await reserve({ start: 10_000, size: 5, vars: ['PORT', 'API_PORT'] });
const { PORT, API_PORT } = slot.vars;
const DB_PORT = slot.getPort(2); // 10002 if the first slot is free
```

TypeScript infers `PORT` and `API_PORT` as `number`. `slot.vars` contains this call's named values and the built-in `PORTO_SLOT`. `slot.ports` lists the ports assigned through `vars` across calls. `getPort()` reads a port by offset.

#### Share a port between variables

```js
import { reserve } from '@b12k/porto';

const slot = await reserve({
  start: 10_000,
  size: 2,
  host: '127.0.0.1',
  idleTtlMinutes: 30,
  keep: true,
  vars: ['PORT', (_slot, port) => ({ API_PORT: port, API_URL: `http://localhost:${port}` })],
});
const { API_PORT, API_URL } = slot.vars;
```

`reserve()` accepts `start`, `size`, `host`, `idleTtlMinutes`, `keep`, and `vars`. All six options are optional. Omit `start` and `size` to reuse the saved repository settings. Other options use the defaults in the config table.

Each entry in `vars` uses one port. The example defines three custom variables with two entries. With `size: 2`, three separate entries throw `PortoError` with code `mappingInvalid` before Porto saves a slot.

#### Read and release slots

```js
import { cleanupSlots, getAllSlots, getSlot, releaseAllSlots, releaseSlot } from '@b12k/porto';

const currentSlot = await getSlot(); // Current slot for this worktree
const selectedSlot = await getSlot(1); // Slot #1
const slots = await getAllSlots(); // All slots for this repository
const releasedSlot = await releaseSlot(); // Release this worktree's slot if its ports are free
const releasedSelectedSlot = await releaseSlot(1); // Release slot #1 if its ports are free
const releasedSlots = await releaseAllSlots(); // Release all slots if their ports are free
const expiredSlots = await cleanupSlots(); // Release expired slots if their ports are free
```
