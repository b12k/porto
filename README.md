# Porto

Stable TCP port blocks for ordinary Git checkouts and linked worktrees. Requires Node.js 24+ and Git.

```sh
pnpm add -D @b12k/porto
```

## Stable blocks

With `start: 1000` and `size: 10`:

| Checkout | Block | Ports     |
| -------- | ----: | --------- |
| main     |     0 | 1000–1009 |
| feature  |     1 | 1010–1019 |

Repeated calls reuse blocks for a range. New blocks skip reserved or busy ports.

```js
import { reserve } from '@b12k/porto';

const block = await reserve({ start: 1000, size: 10 });
block.index; // 0
block.getPort(); // 1000
block.getPort(1); // 1001
```

Defaults: `start: 1000`, `size: 10`, `idleTtlMinutes: 60`. The API takes explicit options; it does not load config files.

## Configuration

```ts
// porto.config.ts
import { defineConfig } from '@b12k/porto';

export default defineConfig({
  start: 1000,
  size: 10,
  idleTtlMinutes: 60,
  keep: true,
  vars: [
    'API_PORT',
    { CLIENT_HOST: (block) => `wt${block}.localhost` },
    { CLIENT_URL: (block, port, idx) => `http://wt${block}.localhost:${port}/${idx}` },
  ],
  envFile: '.env.local',
  write: 'ports.json',
  json: true,
});
```

Variables flatten in order. Callbacks receive the block index, `port = first port + idx`, and the zero-based `idx`. Every entry has a position, including entries that only use the block index. For block `0`:

```dotenv
API_PORT=1000
CLIENT_HOST=wt0.localhost
CLIENT_URL=http://wt0.localhost:1002/2
```

The CLI loads the nearest `porto.config.ts` or `porto.config.js`, searching from cwd to the checkout root. `.ts` wins ties. **Explicit flags > config > defaults.** Config paths are relative to the config file; CLI paths are relative to cwd.

## CLI

```sh
porto reserve --start 1000 --size 10 --idle 60
# Prints the block index when vars and JSON are disabled

porto reserve --vars 'API_PORT;HOST:wt{{block}}.localhost;URL:http://localhost:{{port}}' --env-file
```

`--vars` uses `NAME` or `NAME:template` entries separated by `;`. `{{block}}` inserts the block index; `{{port}}` inserts that entry's indexed port.

| Flag                | Result                                                         |
| ------------------- | -------------------------------------------------------------- |
| `--json`            | JSON block or variables; also applies to `current` and `stats` |
| `--write[=file]`    | Save stdout; default `porto.lock`                              |
| `--env-file[=file]` | Update `.env` by default; writes `PORTO_BLOCK` without vars    |
| `--keep`            | Protect the reservation from idle cleanup                      |

`--no-*` forms disable `vars`, `env-file`, `write`, `json`, and `keep`. Stored `keep` persists when omitted; explicit `false` disables it.

```sh
porto current # Read this checkout's blocks
porto stats   # List repository reservations
porto release # Release this checkout's blocks when all ports are free
porto cleanup # Remove expired, unkept reservations when all ports are free
```

The API exports the same functions. `reserve` refreshes idle TTL and runs cleanup; read commands do neither. Busy release fails without deleting anything.

Reservations share `<git-common-dir>/porto/registry.json`. Port checks do not hold sockets; separate repositories have separate registries. Results use stdout; diagnostics and interactive update notices use stderr. Set `NO_UPDATE_NOTIFIER=1` to disable version checks.
