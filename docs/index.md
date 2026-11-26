# Porto

Porto reserves a range of TCP ports for each Git worktree. Run multiple copies of a project side by side without having to assign ports by hand.

## Install

```sh
pnpm add -D @b12k/porto
```

## Reserve ports

Inside a Git worktree, run:

```sh
pnpm porto --vars 'APP_PORT;API_PORT' --env-path .env.local
```

Porto reserves a slot and writes `APP_PORT`, `API_PORT`, and the slot index (`SLOT`) to `.env.local`. Run the same command again in this worktree to reuse the slot. Another worktree of the same repository gets a different slot.

## Manage reservations

```sh
pnpm porto show
pnpm porto show --all
pnpm porto release
pnpm porto cleanup
```

`show` lists the current reservation, `release` frees it when its ports are no longer in use, and `cleanup` removes expired slots whose ports are free.

See the [CLI, config, and API reference](https://github.com/b12k/porto#use-porto) for more options.
