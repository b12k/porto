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
porto release [slot-number?] [--all?] [--force?]
porto destroy [--force?]
porto cleanup
```

#### Commands

| Command   | Action                                                                 |
| --------- | ---------------------------------------------------------------------- |
| `reserve` | _**(default)**_ Allocate a port slot and print its index or variables. |
| `show`    | Show a slot. Use `--all` to show all slots.                            |
| `release` | Release a slot. Use `--all` for all slots, `--force` for busy ports.   |
| `destroy` | Delete the reservation file entirely. Use `--force` for busy ports.    |
| `cleanup` | Remove expired slots when their ports are free.                        |

#### `reserve` settings

One setting, three ways to set it. Precedence: CLI flag → config file → saved repository settings (`start` and `size` only) → default.

| Setting        | CLI flag                                | Config key       | Default           | Effect                                                                                                                        |
| -------------- | --------------------------------------- | ---------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| First port     | `--start <port>`                        | `start`          | `10000`           | First port of the range. Shared by all worktrees.                                                                             |
| Ports per slot | `--size <count>`                        | `size`           | `10`              | Ports per slot. Shared by all worktrees.                                                                                      |
| Host           | `--host <host>`                         | `host`           | `127.0.0.1`       | Host to check for busy ports. Remembered with the slot, so repeat runs need no `--host`.                                      |
| Idle TTL       | `--idle <minutes>`                      | `idleTtlMinutes` | `60`              | Idle limit, minutes. Each `reserve` restarts the countdown.                                                                   |
| Keep           | `--keep` / `--no-keep`                  | `keep`           | Off for new slots | Keep the slot during idle cleanup. Use `keep: (slot) => slot.index === 0` to decide per slot. Omit to keep the current value. |
| Variables      | `--vars <vars>` / `--no-vars`           | `vars`           | Unset             | One port per entry. `--no-vars` clears the configured list.                                                                   |
| Env output     | `--env` / `--no-env`                    | `env`            | `false`           | Write variables and `SLOT` to an env file.                                                                                    |
| Env file       | `--env-path <file>`                     | `envPath`        | `.env`            | An explicit path enables `env` unless you set `env: false`.                                                                   |
| JSON file      | `--json-path <file>` / `--no-json-path` | `jsonPath`       | `false`           | Save the mapped variables as JSON. `SLOT` alone when no `vars` are given.                                                     |
| Silent         | `--silent` / `--no-silent`              | `silent`         | `false`           | Hide the `reserve` result on stdout. Files are still written.                                                                 |

CLI-only flags: `--json` (print JSON to stdout, also works with `show`).

Relative paths in config start at the config directory. Relative paths in flags start at the current directory.

Use `-h` or `--help` for help. Use `-V` or `--version` for the version.

##### `--vars` template syntax

Use `;` to move to the next port and `|` to share the current port. Use `NAME` for a port number or `NAME=template` for text. Templates accept `{{slot}}` and `{{port}}`. Map `SLOT` explicitly when you need the slot index next to other variables: `--vars "SLOT={{slot}};API_PORT"`.

##### Write to files

```sh
pnpm porto --vars "CLIENT_PORT|HOST_URL=http://localhost:{{port}};API_PORT" --env-path .env.local --json-path env.json
```

If the first slot is free, Porto writes these files. `SLOT` is included only when no other variables are given — otherwise map it explicitly as shown above.

`.env.local`

```dotenv
CLIENT_PORT=10000
HOST_URL=http://localhost:10000
API_PORT=10001
```

`env.json`

```json
{ "CLIENT_PORT": 10000, "HOST_URL": "http://localhost:10000", "API_PORT": 10001 }
```

Run the same command again in this worktree to reuse its slot. A second worktree gets its own slot.

To change `--start` or `--size`, release all slots first.

| Worktree | Slot | Ports       |
| -------- | ---: | ----------- |
| Main     |    0 | 10000-10009 |
| Feature  |    1 | 10010-10019 |

#### `show` and `release` options

| Argument or option | Default              | Action                                |
| ------------------ | -------------------- | ------------------------------------- |
| `[slot-number]`    | This worktree's slot | Select a slot by index.               |
| `--all`            | Off                  | Select all slots for this repository. |
| `--force`          | Off                  | Release slots even if ports are busy. |

Use a slot number or `--all`. If a port is busy, `release --all` frees the other slots, keeps the busy ones, and reports an error unless `--force` is set.

### Config

The CLI loads config for `reserve` and `release`. Create `porto.config.ts` or `porto.config.js` in your worktree. Porto searches from the current directory to the worktree root. If both files are in one directory, Porto uses the TypeScript file.

```ts
import { defineConfig } from '@b12k/porto';

export default defineConfig({
  start: 10_000,
  size: 10,
  host: '127.0.0.1',
  idleTtlMinutes: 60,
  keep: false,
  env: true,
  envPath: '.env.local',
  jsonPath: 'ports.json',
  silent: false,
  vars: [
    'PORT',
    (port, slotIndex) => ({ PORT_2: port, HOST_NAME: `https://localhost:${port}`, SLOT: slotIndex }),
    'DB_PORT',
  ],
  onReserved(slot) {
    console.error(`Reserved slot ${slot.index} with ports ${slot.ports.join(', ')}`);
  },
  onReleased(slot) {
    console.error(`Released slot ${slot.index} with ports ${slot.ports.join(', ')}`);
  },
});
```

All properties are optional. Every setting from [reserve settings](#reserve-settings) also works as a config key.

| Property     | Effect                                                         |
| ------------ | -------------------------------------------------------------- |
| `onReserved` | Run after Porto saves the slot and writes the requested files. |
| `onReleased` | Run once per slot freed by `release`.                          |

A `vars` function receives `(port, slot)`. Return an object with string or number values. In the example, `PORT_2` and `HOST_NAME` use the same port, and `SLOT` maps the slot index explicitly.

A `keep` function receives the slot and returns whether to keep it during idle cleanup. It runs on every `reserve` after variables are mapped, so `slot.vars` can be used in the decision — for example, `keep: (slot) => slot.index === 0` pins the first slot while other slots expire normally. CLI `--keep` / `--no-keep` flags override the configured value.

Both hooks receive `(slot)`, where `slot.ports` lists the ports assigned to that slot. Hooks can return a promise.

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

TypeScript infers `PORT` and `API_PORT` as `number`. `slot.vars` contains this call's named values; with no `vars` given it contains only the built-in `SLOT`. `slot.ports` lists the ports assigned through `vars`. `getPort()` reads a port by offset.

#### Share a port between variables

```js
import { reserve } from '@b12k/porto';

const slot = await reserve({
  start: 10_000,
  size: 2,
  host: '127.0.0.1',
  idleTtlMinutes: 30,
  keep: true,
  vars: ['PORT', (port, slot) => ({ API_PORT: port, API_URL: `http://localhost:${port}`, SLOT: slot })],
});
const { API_PORT, API_URL } = slot.vars;
```

`reserve()` accepts `start`, `size`, `host`, `idleTtlMinutes`, `keep`, and `vars`. All six options are optional. `keep` accepts a boolean or a `(slot) => boolean` predicate. Omit `start` and `size` to reuse the saved repository settings. Other options use the defaults in the [reserve settings](#reserve-settings) table.

Each entry in `vars` uses one port. The example maps four variables with two entries. With `size: 2`, three separate entries throw `PortoError` with code `mappingInvalid` before Porto saves a slot.

#### Read and release slots

```js
import { cleanupSlots, destroy, getAllSlots, getSlot, releaseAllSlots, releaseSlot } from '@b12k/porto';

const currentSlot = await getSlot(); // Current slot for this worktree
const selectedSlot = await getSlot(1); // Slot #1
const slots = await getAllSlots(); // All slots for this repository
const releasedSlot = await releaseSlot(); // Release this worktree's slot if its ports are free
const forceReleasedSlot = await releaseSlot(true); // Force release this worktree's slot
const releasedSelectedSlot = await releaseSlot(1); // Release slot #1 if its ports are free
const forceReleasedSelectedSlot = await releaseSlot(1, true); // Force release slot #1 even if its ports are busy
const releasedSlots = await releaseAllSlots(); // Release all slots if their ports are free
const forceReleasedSlots = await releaseAllSlots(true); // Force release all slots even if ports are busy
const expiredSlots = await cleanupSlots(); // Release expired slots if their ports are free
await destroy(); // Delete the reservation file if every port is free
await destroy(true); // Delete the reservation file even if ports are busy
```
