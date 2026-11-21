import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { fetchFreeRange } from './fixture';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const apiUrl = new URL('../src/index.ts', import.meta.url).href;
const tsxPath = import.meta.resolve('tsx');
let directoryPath: string;
let start: number;

function runCli(args: Array<string>) {
  return execFileAsync(process.execPath, ['--import', tsxPath, '--', cliPath, ...args], { cwd: directoryPath });
}

function reserveSlot() {
  return runCli(['reserve', '--start', String(start), '--size', '1', '--host', '127.0.0.1']);
}

async function runApi(source: string) {
  const script = `const { releaseAllSlots, releaseSlot } = await import(${JSON.stringify(apiUrl)}); ${source}`;
  const { stdout } = await execFileAsync(process.execPath, ['--import', tsxPath, '--input-type=module', '-e', script], {
    cwd: directoryPath,
  });
  return JSON.parse(stdout) as unknown;
}

function runGit(args: Array<string>) {
  return execFileAsync('git', args, { cwd: directoryPath });
}

async function showAll() {
  const { stdout } = await runCli(['show', '--all', '--json']);
  return JSON.parse(stdout) as unknown;
}

async function releaseBusySlot(release: () => Promise<unknown>) {
  await reserveSlot();
  const server = createServer();
  server.listen({ host: '127.0.0.1', port: start });
  await once(server, 'listening');
  try {
    await release();
    expect(await showAll()).toEqual([]);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-force-'));
  await runGit(['init', '-q']);
  start = await fetchFreeRange(4);
});

afterEach(async () => {
  const targetPath = path.resolve(directoryPath);
  if (path.dirname(targetPath) !== path.resolve(tmpdir()) || !path.basename(targetPath).startsWith('porto-force-')) {
    throw new Error('Refusing to remove a directory outside the test fixture.');
  }
  await rm(targetPath, { force: true, recursive: true });
});

it('forces release of busy slots with --force and the force API flag', async () => {
  await releaseBusySlot(() => runCli(['release', '--force']));
  await releaseBusySlot(() => runApi('console.log(JSON.stringify(await releaseSlot(true)));'));
  await releaseBusySlot(() => runApi('console.log(JSON.stringify(await releaseSlot(0, true)));'));
  await releaseBusySlot(() => runCli(['release', '--all', '--force']));
  await releaseBusySlot(() => runApi('console.log(JSON.stringify(await releaseAllSlots(true)));'));
});
