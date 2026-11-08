import { range, remove, union } from 'es-toolkit';

import type { ReservationRecord } from './registry';
import type { Vars } from './vars';

import { PortoError } from './error';
import { fetchGitContext } from './git';
import { buildBlock, checkHasBusyPort } from './ports';
import { updateRegistry } from './registry';
import { parseOptions } from './schemas';
import { assertVarsFit, parseVarEntries } from './vars';

export type ReserveOptions = Partial<ReturnType<typeof parseOptions>> & { vars?: undefined | Vars };

export function checkIsExpired(record: Pick<ReservationRecord, 'idleTtlMinutes' | 'keep' | 'lastUsedAt'>, now: number) {
  return !record.keep && now - Date.parse(record.lastUsedAt) > record.idleTtlMinutes * 60_000;
}

export async function removeExpiredRecords(records: ReservationRecord[], now: number) {
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

async function allocateRecord(records: ReservationRecord[], options: Omit<ReservationRecord, 'index'>) {
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

function issuePorts(record: ReservationRecord, portsCount: number) {
  const block = buildBlock(record);
  record.ports = union(record.ports, range(block.start, block.start + portsCount));
  return Object.assign(block, { ports: record.ports });
}

export async function reserveBlock<Result>(
  {
    git,
    host,
    idleTtlMinutes,
    keep,
    portsCount,
    size,
    start,
  }: ReturnType<typeof parseOptions> & { git?: Awaited<ReturnType<typeof fetchGitContext>>; portsCount: number },
  prepare: (block: ReturnType<typeof issuePorts>) => Result,
) {
  assertVarsFit(portsCount, size);
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
    return prepare(issuePorts(record, portsCount));
  });
}

export async function reserve(options: ReserveOptions = {}) {
  const settings = parseOptions(options);
  const portsCount = options.vars === undefined ? 0 : parseVarEntries(options.vars).length;
  return reserveBlock({ ...settings, portsCount }, (block) => block);
}
