import { connect } from 'node:net';

import type { ReservationRecord } from './registry';

import { PortoError } from './error';

const CONNECT_TIMEOUT_MS = 1000;

type PortSlot = ReturnType<typeof buildSlot<ReservationRecord>>;

function buildSlot<Slot extends { firstPort: number; lastPort: number }>(record: Slot, index: number) {
  return {
    ...record,
    getPort(offset = 0) {
      if (!Number.isInteger(offset) || offset < 0 || record.firstPort + offset > record.lastPort) {
        throw new PortoError(
          'offsetInvalid',
          `offset must be an integer between 0 and ${record.lastPort - record.firstPort}.`,
        );
      }
      return record.firstPort + offset;
    },
    index,
  };
}

function probePort(port: number, host: string): Promise<boolean> {
  // A connection attempt never occupies the port, so parallel probes cannot
  // Mistake each other for a busy port the way bind probes did.
  // oxlint-disable-next-line promise/avoid-new
  return new Promise<boolean>((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      const error = new Error(`Connection to ${host}:${port} timed out.`) as NodeJS.ErrnoException;
      error.code = 'ETIMEDOUT';
      reject(error);
    }, CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // Refused means nothing accepts connections there; anything else
      // (DNS, routing, timeouts) leaves the state unverified.
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

async function listBusyPorts(
  start: number,
  end: number,
  { host, stopAtFirst = false }: { host: string; stopAtFirst?: boolean },
) {
  const busyPorts: Array<number> = [];
  for (let port = start; port <= end; port += 1) {
    // oxlint-disable-next-line no-await-in-loop
    if (await probePort(port, host)) {
      busyPorts.push(port);
      if (stopAtFirst) return busyPorts;
    }
  }
  return busyPorts;
}

async function checkHasBusyPort(start: number, end: number, host: string) {
  const busyPorts = await listBusyPorts(start, end, { host, stopAtFirst: true });
  return busyPorts.length > 0;
}

export { buildSlot, checkHasBusyPort, listBusyPorts };
export type { PortSlot };
