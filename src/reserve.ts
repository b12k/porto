import { range, remove, union } from 'es-toolkit';

import type { ReservationRecord } from './registry';
import type { Vars, VarsResult } from './vars';

import { PortoError } from './error';
import { fetchGitContext } from './git';
import { buildBlock, checkHasBusyPort } from './ports';
import { updateRegistry } from './registry';
import { parseOptions } from './schemas';
import { assertVarsFit, mapBlockToVars, parseVarEntries } from './vars';

type ReservedBlock<Entries extends Vars = Vars> = ReturnType<typeof buildBlock> & {
  ports: Array<number>;
  vars: VarsResult<Entries>;
};
type ReserveOptions = Partial<ReturnType<typeof parseOptions>> & { vars?: undefined | Vars };

async function allocateRecord(records: Array<ReservationRecord>, options: Omit<ReservationRecord, 'index'>) {
  for (let index = 0; options.start + (index + 1) * options.size - 1 <= 65_535; index += 1) {
    const record = { ...options, index };
    const block = buildBlock(record);
    const hasOverlap = records.some((reserved) => {
      const reservedBlock = buildBlock(reserved);
      return block.start <= reservedBlock.end && block.end >= reservedBlock.start;
    });
    // Check candidates in order without opening thousands of sockets at once.
    // oxlint-disable-next-line no-await-in-loop
    if (!hasOverlap && !(await checkHasBusyPort(block.start, block.end, options.host))) return record;
  }
  throw new PortoError('blockUnavailable');
}

function checkIsExpired(record: Pick<ReservationRecord, 'idleTtlMinutes' | 'keep' | 'lastUsedAt'>, now: number) {
  return !record.keep && now - Date.parse(record.lastUsedAt) > record.idleTtlMinutes * 60_000;
}

function issuePorts(record: ReservationRecord, entries: Vars) {
  const block = buildBlock(record);
  const vars = mapBlockToVars(block, entries);
  record.ports = union(record.ports, range(block.start, block.start + entries.length));
  return Object.assign(block, { ports: record.ports, vars });
}

async function removeExpiredRecords(records: Array<ReservationRecord>, now: number) {
  const candidates = await Promise.all(
    records
      .filter((record) => checkIsExpired(record, now))
      .map(async (record) => {
        const { end, start } = buildBlock(record);
        return { hasBusyPort: await checkHasBusyPort(start, end, record.host), record };
      }),
  );
  const expiredRecords = candidates.filter(({ hasBusyPort }) => !hasBusyPort).map(({ record }) => record);
  remove(records, (record) => expiredRecords.includes(record));
  return expiredRecords.map((record) => buildBlock(record));
}

async function commitReservation<Result>(
  {
    git,
    host,
    idleTtlMinutes,
    keep,
    size,
    start,
    vars = [],
  }: ReturnType<typeof parseOptions> & { git?: Awaited<ReturnType<typeof fetchGitContext>>; vars?: undefined | Vars },
  prepare: (block: ReturnType<typeof issuePorts>) => Result,
) {
  assertVarsFit(vars.length, size);
  const { commonDirectory, worktree, worktreeId } = git ?? (await fetchGitContext());
  return updateRegistry(commonDirectory, async (records) => {
    const now = Date.now();
    const existingRecord = records.find(
      (record) => record.worktreeId === worktreeId && record.start === start && record.size === size,
    );
    const lastUsedAt = new Date(now).toISOString();
    if (existingRecord) {
      Object.assign(existingRecord, {
        host: host ?? existingRecord.host,
        idleTtlMinutes,
        keep: keep ?? existingRecord.keep,
        lastUsedAt,
        worktree,
      });
    }
    await removeExpiredRecords(records, now);
    const record =
      existingRecord ??
      (await allocateRecord(records, {
        host,
        idleTtlMinutes,
        keep: keep ?? false,
        lastUsedAt,
        ports: [],
        size,
        start,
        worktree,
        worktreeId,
      }));
    if (!existingRecord) records.push(record);
    // A failed factory must leave the registry untouched.
    return prepare(issuePorts(record, vars));
  });
}

async function reserve<const Entries extends Vars>(
  options: ReserveOptions & { vars: Entries },
): Promise<ReservedBlock<Entries>>;
async function reserve(options?: ReserveOptions): Promise<ReservedBlock>;
async function reserve(options: ReserveOptions = {}) {
  const settings = parseOptions(options);
  const vars = options.vars === undefined ? undefined : parseVarEntries(options.vars);
  const block = await commitReservation({ ...settings, vars }, (reservedBlock) => reservedBlock);
  return block;
}

export { checkIsExpired, commitReservation, removeExpiredRecords, reserve };
export type { ReserveOptions };
