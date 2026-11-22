import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';

import { fetchFreeRange } from './fixture';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(import.meta.dirname, '../src/cli.ts');
const tsxPath = import.meta.resolve('tsx');
let directoryPath: string;
let repositoryPath: string;
let start: number;

function runGit(args: Array<string>, cwd = repositoryPath) {
  return execFileAsync('git', args, { cwd });
}

function runReserve(args: Array<string>, cwd: string) {
  return execFileAsync(process.execPath, ['--import', tsxPath, '--', cliPath, ...args], { cwd });
}

async function waitForStuckFirst(registryPath: string, jsonPath: string, deadline: number): Promise<void> {
  try {
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toMatchObject({
      slots: { 0: { vars: { LABEL: 'first' } } },
    });
    expect(JSON.parse(await readFile(jsonPath, 'utf8'))).toEqual({ LABEL: 'first' });
    return;
  } catch {
    // The first reservation is not saved and exported yet; poll again.
  }
  if (Date.now() > deadline) throw new Error('Timed out waiting for the first reservation.');
  await setTimeout(50);
  return waitForStuckFirst(registryPath, jsonPath, deadline);
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

it('keeps the registry and JSON export consistent across overlapping CLI reserves', async () => {
  const worktreePath = path.join(directoryPath, 'other');
  await runGit(['worktree', 'add', '--detach', worktreePath]);
  const jsonPath = path.join(repositoryPath, 'ports.json');
  const envPath = path.join(repositoryPath, 'shared.env');
  const registryPath = path.join(repositoryPath, '.git', 'porto-registry.json');
  const pending: Array<Promise<unknown>> = [];
  // Hold the env file lock so the first reserve pauses inside its export
  // Window while still holding the registry lock. No fixed sleep decides the
  // Overlap: the pause lasts until the test releases it below.
  const releaseEnvLock = await lockfile.lock(envPath, {
    realpath: false,
    retries: { factor: 1, maxTimeout: 100, minTimeout: 100, retries: 200 },
    stale: 120_000,
    update: 2000,
  });
  let envReleased = false;
  async function doReleaseEnvLock() {
    if (!envReleased) {
      envReleased = true;
      await releaseEnvLock();
    }
  }
  try {
    const first = runReserve(
      [
        'reserve',
        '--start',
        String(start),
        '--size',
        '2',
        '--vars',
        'LABEL=first',
        '--env-path',
        envPath,
        '--json-path',
        jsonPath,
      ],
      repositoryPath,
    );
    pending.push(first);
    // The registry entry plus the JSON file prove the first reserve reached
    // The env export: it cannot finish while this test holds the env lock,
    // So it is stuck keeping the registry lock.
    await waitForStuckFirst(registryPath, jsonPath, Date.now() + 15_000);
    const secondState = { done: false };
    const second = runReserve(
      ['reserve', '--start', String(start), '--size', '2', '--vars', 'LABEL=second', '--json-path', jsonPath],
      worktreePath,
    ).then((result) => {
      secondState.done = true;
      return result;
    });
    pending.push(second);
    // If the second reserve finishes before the env lock is released, it
    // Slipped through without waiting: the exports left the registry lock.
    await setTimeout(5000);
    if (secondState.done) throw new Error('The second reserve finished while the first still held the registry lock.');
    await doReleaseEnvLock();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.stdout).toContain('LABEL=first');
    expect(secondResult.stdout).toContain('LABEL=second');
    // The last completed CLI reservation wins the shared file; a stale export
    // From the first process must not survive after the second one.
    const file: unknown = JSON.parse(await readFile(jsonPath, 'utf8'));
    expect(file).toEqual({ LABEL: 'second' });
    const registry: unknown = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(registry).toMatchObject({ slots: { 0: { vars: { LABEL: 'first' } }, 1: { vars: { LABEL: 'second' } } } });
  } finally {
    await doReleaseEnvLock();
    await Promise.allSettled(pending);
  }
});
