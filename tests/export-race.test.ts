import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

import { fetchFreeRange } from './fixture';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(import.meta.dirname, '../src/cli.ts');
const reserveUrl = new URL('../src/reserve.ts', import.meta.url).href;
const gitUrl = new URL('../src/git.ts', import.meta.url).href;
const outputUrl = new URL('../src/output.ts', import.meta.url).href;
const varsUrl = new URL('../src/vars.ts', import.meta.url).href;
const tsxPath = import.meta.resolve('tsx');
let directoryPath: string;
let repositoryPath: string;
let start: number;

function runGit(args: Array<string>, cwd = repositoryPath) {
  return execFileAsync('git', args, { cwd });
}

function runReserve(args: Array<string>, cwd: string, delayMs: string) {
  return execFileAsync(process.execPath, ['--import', tsxPath, '--', cliPath, ...args], {
    cwd,
    env: { ...process.env, PORTO_TEST_EXPORT_DELAY_MS: delayMs },
  });
}

async function waitForFirstSlot(registryPath: string, deadline: number): Promise<void> {
  let saved = false;
  try {
    const snapshot: unknown = JSON.parse(await readFile(registryPath, 'utf8'));
    saved =
      typeof snapshot === 'object' &&
      snapshot !== null &&
      'slots' in snapshot &&
      typeof snapshot.slots === 'object' &&
      snapshot.slots !== null &&
      '0' in snapshot.slots;
  } catch {
    // The registry file does not exist yet.
  }
  if (saved) return;
  if (Date.now() > deadline) throw new Error('Timed out waiting for the first reservation.');
  await setTimeout(50);
  return waitForFirstSlot(registryPath, deadline);
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-export-race-'));
  repositoryPath = path.join(directoryPath, 'repository');
  await mkdir(repositoryPath);
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
  start = await fetchFreeRange(8);
});

afterEach(async () => {
  const resolvedPath = path.resolve(directoryPath);
  if (
    path.dirname(resolvedPath) !== path.resolve(tmpdir()) ||
    !path.basename(resolvedPath).startsWith('porto-export-race-')
  ) {
    throw new Error('Refusing to remove a directory outside the test fixture.');
  }
  await rm(resolvedPath, { force: true, recursive: true });
});

it('keeps the registry and JSON export consistent under overlapping reserves', async () => {
  const worktreePath = path.join(directoryPath, 'other');
  await runGit(['worktree', 'add', '--detach', worktreePath]);
  const jsonPath = path.join(repositoryPath, 'ports.json');
  const script = `
    const { commitReservation } = await import(${JSON.stringify(reserveUrl)});
    const { fetchGitContext } = await import(${JSON.stringify(gitUrl)});
    const { writeReserveJsonFile } = await import(${JSON.stringify(outputUrl)});
    const { parseVars } = await import(${JSON.stringify(varsUrl)});
    const { readFile } = await import('node:fs/promises');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    process.chdir(${JSON.stringify(repositoryPath)});
    const gitA = await fetchGitContext();
    process.chdir(${JSON.stringify(worktreePath)});
    const gitB = await fetchGitContext();
    let entered = false;
    const first = commitReservation(
      gitA,
      { start: ${start}, size: 2, vars: parseVars('LABEL=first') },
      undefined,
      async (vars) => {
        entered = true;
        await sleep(800);
        await writeReserveJsonFile(${JSON.stringify(jsonPath)}, vars);
      },
    );
    while (!entered) await sleep(50);
    const second = commitReservation(
      gitB,
      { start: ${start}, size: 2, vars: parseVars('LABEL=second') },
      undefined,
      async (vars) => writeReserveJsonFile(${JSON.stringify(jsonPath)}, vars),
    );
    const [s1, s2] = await Promise.all([first, second]);
    const file = JSON.parse(await readFile(${JSON.stringify(jsonPath)}, 'utf8'));
    console.log(JSON.stringify({ file, s1: s1.vars, s2: s2.vars, i1: s1.index, i2: s2.index }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--import', tsxPath, '--input-type=module', '-e', script], {
    cwd: repositoryPath,
  });
  // The last completed reservation wins the shared file; a stale export
  // From the first reservation must not survive after the second one.
  const result: unknown = JSON.parse(stdout);
  expect(result).toMatchObject({
    file: { LABEL: 'second' },
    i1: 0,
    i2: 1,
    s1: { LABEL: 'first' },
    s2: { LABEL: 'second' },
  });
  const registry: unknown = JSON.parse(
    await readFile(path.join(repositoryPath, '.git', 'porto-registry.json'), 'utf8'),
  );
  expect(registry).toMatchObject({ slots: { 0: { vars: { LABEL: 'first' } }, 1: { vars: { LABEL: 'second' } } } });
});

it('keeps the registry and JSON export consistent across overlapping CLI reserves', async () => {
  const worktreePath = path.join(directoryPath, 'other');
  await runGit(['worktree', 'add', '--detach', worktreePath]);
  const jsonName = path.join(repositoryPath, 'ports.json');
  function runReserveArgs(label: string): Array<string> {
    return ['reserve', '--start', String(start), '--size', '2', '--vars', `LABEL=${label}`, '--json-path', jsonName];
  }
  const first = runReserve(runReserveArgs('first'), repositoryPath, '3000');
  // Wait until the first reservation is saved so the second one overlaps it
  // Inside the JSON export window while the registry lock is still held.
  await waitForFirstSlot(path.join(repositoryPath, '.git', 'porto-registry.json'), Date.now() + 10_000);
  const second = runReserve(runReserveArgs('second'), worktreePath, '0');
  const [firstResult, secondResult] = await Promise.all([first, second]);
  expect(firstResult.stdout).toContain('LABEL=first');
  expect(secondResult.stdout).toContain('LABEL=second');
  const file: unknown = JSON.parse(await readFile(jsonName, 'utf8'));
  // The last completed CLI reservation wins the shared file; a stale export
  // From the first process must not survive after the second one.
  expect(file).toEqual({ LABEL: 'second' });
  const registry: unknown = JSON.parse(
    await readFile(path.join(repositoryPath, '.git', 'porto-registry.json'), 'utf8'),
  );
  expect(registry).toMatchObject({ slots: { 0: { vars: { LABEL: 'first' } }, 1: { vars: { LABEL: 'second' } } } });
});
