import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { fetchFreeRange } from './fixture';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(import.meta.dirname, '../src/cli.ts');
const apiUrl = new URL('../src/index.ts', import.meta.url).href;
const tsxPath = import.meta.resolve('tsx');
let directoryPath: string;
let otherPath: string;
let start: number;

function runCli(args: Array<string>, cwd = directoryPath) {
  return execFileAsync(process.execPath, ['--import', tsxPath, '--', cliPath, ...args], { cwd });
}

async function reserveSlots() {
  const args = ['reserve', '--start', String(start), '--size=2', '--host=127.0.0.1', '--vars=API_PORT'];
  await runCli([...args, '--keep']);
  await runCli(args, otherPath);
}

async function runApi(source: string) {
  const script = `const { getAllSlots, releaseAllSlots, releaseSlot } = await import(${JSON.stringify(apiUrl)}); ${source}`;
  const { stdout } = await execFileAsync(process.execPath, ['--import', tsxPath, '--input-type=module', '-e', script], {
    cwd: directoryPath,
  });
  return JSON.parse(stdout) as unknown;
}

function runGit(args: Array<string>) {
  return execFileAsync('git', args, { cwd: directoryPath });
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-all-'));
  directoryPath = await realpath(directoryPath);
  await runGit(['init', '-q']);
  await runGit([
    '-c',
    'user.name=Porto Test',
    '-c',
    'user.email=porto@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'initial',
  ]);
  otherPath = path.join(directoryPath, 'other');
  await runGit(['worktree', 'add', '--detach', otherPath]);
  start = await fetchFreeRange(8);
});

afterEach(async () => {
  const targetPath = path.resolve(directoryPath);
  const tempPath = await realpath(tmpdir());
  if (path.dirname(targetPath) !== tempPath || !path.basename(targetPath).startsWith('porto-all-')) {
    throw new Error('Refusing to remove a directory outside the test fixture.');
  }
  await rm(targetPath, { force: true, recursive: true });
});

it('shows the current slot, a selected slot or all slots as JSON and a table', async () => {
  await reserveSlots();
  const current = await runCli(['show']);
  const other = await runCli(['show'], otherPath);
  for (const output of [current.stdout, other.stdout]) {
    expect(output).toMatch(/SLOT.*PORTS.*WORKTREE/su);
    expect(output).toMatch(/VARS.*BUSY PORTS/su);
  }
  expect(current.stdout).toContain(`API_PORT=${start}`);
  expect(other.stdout).toContain(`API_PORT=${start + 2}`);
  expect(current.stdout).toMatch(/│\s*0\s*│/u);
  expect(other.stdout).toMatch(/│\s*1\s*│/u);
  expect(current.stdout).toMatch(new RegExp(`│ +${start}-${start + 1} +│`, 'u'));
  const selected = await runCli(['show', '0', '--json'], otherPath);
  expect(JSON.parse(selected.stdout)).toMatchObject({ index: 0 });
  const all = await runCli(['show', '--all', '--json']);
  expect(JSON.parse(all.stdout)).toMatchObject([{ index: 0 }, { index: 1 }]);
  const table = await runCli(['show', '--all']);
  expect(table.stdout).toMatch(/SLOT.*PORTS.*WORKTREE/su);
  expect(table.stdout).toMatch(/VARS.*BUSY PORTS/su);
  expect(table.stdout).toMatch(/│\s*other\s*│/u);
});

it('returns every released slot with saved values, including kept slots, and allows retries', async () => {
  expect(await runApi('console.log(JSON.stringify(await releaseAllSlots()));')).toEqual([]);
  await reserveSlots();
  await writeFile(path.join(directoryPath, 'porto.config.ts'), "throw new Error('The API must not load config.');");
  const source =
    'const slots = await releaseAllSlots(); console.log(JSON.stringify(slots.map(slot => ({ index: slot.index, keep: slot.keep, port: slot.getPort(), vars: slot.vars }))));';
  expect(await runApi(source)).toEqual([
    { index: 0, keep: true, port: start, vars: { API_PORT: start } },
    { index: 1, keep: false, port: start + 2, vars: { API_PORT: start + 2 } },
  ]);
  expect(await runApi('console.log(JSON.stringify(await getAllSlots()));')).toEqual([]);
  expect(await runApi('console.log(JSON.stringify(await releaseAllSlots()));')).toEqual([]);
});

it('releases occupied array positions without treating free slots as reservations', async () => {
  await reserveSlots();
  await runCli(['release', '0']);
  expect(await runApi('console.log(JSON.stringify(await releaseAllSlots()));')).toMatchObject([{ index: 1 }]);
  const contents = await readFile(path.join(directoryPath, '.git', 'porto-registry.json'), 'utf8');
  expect(JSON.parse(contents)).toEqual({ portsPerSlot: 2, slots: {}, startPort: start });
});

it('releases free slots on a busy-port failure and runs hooks for every freed slot', async () => {
  await reserveSlots();
  await writeFile(
    path.join(directoryPath, 'porto.config.ts'),
    `import { appendFileSync } from 'node:fs';
    export default { onReleased(slot) {
      appendFileSync('released.jsonl', JSON.stringify({ index: slot.index, ports: slot.ports }) + '\\n');
    } };`,
  );
  const registryPath = path.join(directoryPath, '.git', 'porto-registry.json');
  const server = createServer();
  server.listen({ host: '127.0.0.1', port: start + 2 });
  await once(server, 'listening');
  try {
    const { stdout } = await runCli(['show', '1']);
    expect(stdout).toMatch(new RegExp(`│ +${start + 2} +│$`, 'mu'));
    // The free slot is saved as released and hooked despite the busy one.
    await expect(runCli(['release', '--all'])).rejects.toThrow('Cannot release reservations while ports are in use.');
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toMatchObject({
      slots: { 1: { vars: { API_PORT: start + 2 } } },
    });
    expect(await readFile(path.join(directoryPath, 'released.jsonl'), 'utf8')).toBe(`{"index":0,"ports":[${start}]}\n`);
    const source = 'try { await releaseAllSlots(); } catch (error) { console.log(JSON.stringify(error.ports)); }';
    expect(await runApi(source)).toEqual([{ port: start + 2, slot: 1 }]);
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toMatchObject({
      slots: { 1: { vars: { API_PORT: start + 2 } } },
    });
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  await runCli(['release', '--all']);
  await runCli(['release', '--all']);
  const released = await readFile(path.join(directoryPath, 'released.jsonl'), 'utf8');
  expect(
    released
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown),
  ).toEqual([
    { index: 0, ports: [start] },
    { index: 1, ports: [start + 2] },
  ]);
});

it('awaits every bulk release hook before reporting a hook failure', async () => {
  await reserveSlots();
  await writeFile(
    path.join(directoryPath, 'porto.config.ts'),
    `import { appendFileSync } from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    export default { async onReleased(slot) {
      if (slot.index === 1) await setTimeout(20);
      appendFileSync('hooks.txt', slot.index + '\\n');
      if (slot.index === 0) throw new Error('first hook failed');
    } };`,
  );
  await expect(runCli(['release', '--all'])).rejects.toThrow('onReleased: first hook failed');
  expect(await readFile(path.join(directoryPath, 'hooks.txt'), 'utf8')).toBe('0\n1\n');
  expect(await runApi('console.log(JSON.stringify(await getAllSlots()));')).toEqual([]);
});

it.each([false, true])(
  'runs release hooks and reports unresolved hosts when a busy slot is present: %s',
  async (hasBusySlot) => {
    await reserveSlots();
    await runCli(['reserve', '--host=porto-audit-missing.invalid'], otherPath);
    const busyServer = createServer();
    const busyPort = start + 4;
    if (hasBusySlot) {
      const busyPath = path.join(directoryPath, 'busy');
      await runGit(['worktree', 'add', '--detach', busyPath]);
      await runCli(['reserve', '--host=127.0.0.1'], busyPath);
      busyServer.listen({ host: '127.0.0.1', port: busyPort });
      await once(busyServer, 'listening');
    }
    try {
      await writeFile(
        path.join(directoryPath, 'porto.config.ts'),
        `import { appendFileSync } from 'node:fs';
      export default { onReleased(slot) { appendFileSync('released.txt', slot.index + '\\n'); } };`,
      );
      const failure = runCli(['release', '--all']);
      const unresolved = expect.stringMatching(/unverified[\s│]+host: 1/u) as unknown;
      await expect(failure).rejects.toMatchObject({ code: 1, stderr: unresolved });
      if (hasBusySlot) {
        await expect(failure).rejects.toMatchObject({
          stderr: expect.stringMatching(new RegExp(`│\\s*2\\s*│\\s*${busyPort}\\s*│`, 'u')) as unknown,
        });
      }
      expect(await readFile(path.join(directoryPath, 'released.txt'), 'utf8')).toBe('0\n');
      expect(await runApi('console.log(JSON.stringify((await getAllSlots()).map(slot => slot.index)));')).toEqual(
        hasBusySlot ? [1, 2] : [1],
      );
    } finally {
      if (busyServer.listening) {
        const closed = once(busyServer, 'close');
        busyServer.close();
        await closed;
      }
    }
  },
);

it.each([
  { args: ['show', '0', '--all'] },
  { args: ['release', '0', '--all'] },
  { args: ['show', 'bad', '--all'] },
  { args: ['release', 'bad', '--all'] },
  { args: ['slot'] },
  { args: ['all'] },
])('rejects conflicting selectors and removed commands before allocating: %j', async ({ args }) => {
  await expect(runCli(args)).rejects.toMatchObject({ code: 1, stdout: '' });
  await expect(readFile(path.join(directoryPath, '.git', 'porto-registry.json'))).rejects.toThrow(/ENOENT/u);
});
