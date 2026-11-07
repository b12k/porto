import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

import { PortoError } from './error';

// oxlint-disable-next-line typescript/strict-void-return
const execFileAsync = promisify(execFile);

export async function fetchGitContext() {
  try {
    const { stdout } = await execFileAsync('git', [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
    ]);
    const [worktree, commonDirectory] = stdout.trim().split(/\r?\n/u);
    if (!worktree || !commonDirectory) throw new Error('Missing Git paths.');

    return { commonDirectory: await realpath(commonDirectory), worktree: await realpath(worktree) };
  } catch (error) {
    throw new PortoError('worktreeNotFound', undefined, { cause: error });
  }
}
