import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';

import type { ReservationRecord } from './registry';

import { PortoError } from './error';

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

function checkIsAddressAvailable(port: number, host: string, isAutomatic: boolean) {
  // Node's TCP listen/close API uses callbacks.
  // oxlint-disable-next-line promise/avoid-new
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else if (isAutomatic && host.includes(':') && (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL')) {
        resolve(true);
      } else reject(error);
    });
    server.listen({ exclusive: true, host, ipv6Only: true, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

function getProbeHosts() {
  const interfaceHosts = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? []).map((address) => {
      if (address.family !== 'IPv6' || address.scopeid === 0) return address.address;
      // Libuv expects a numeric IPv6 zone on Windows and an interface name on Unix.
      const zone = process.platform === 'win32' ? address.scopeid : name;
      return `${address.address}%${zone}`;
    }),
  );
  return new Set(['0.0.0.0', '127.0.0.1', '::', '::1', ...interfaceHosts]);
}

async function listBusyPorts(
  start: number,
  end: number,
  { host, stopAtFirst = false }: { host?: string | undefined; stopAtFirst?: boolean } = {},
) {
  const busyPorts: Array<number> = [];
  const hosts = host === undefined ? getProbeHosts() : [host];
  for (let port = start; port <= end; port += 1) {
    // Windows can bind wildcard sockets alongside listeners on a specific interface.
    for (const probeHost of hosts) {
      // These probes must not collide with sockets opened by another probe.
      // oxlint-disable-next-line no-await-in-loop
      if (!(await checkIsAddressAvailable(port, probeHost, host === undefined))) {
        busyPorts.push(port);
        if (stopAtFirst) return busyPorts;
        break;
      }
    }
  }
  return busyPorts;
}

async function checkHasBusyPort(start: number, end: number, host?: string) {
  const busyPorts = await listBusyPorts(start, end, { host, stopAtFirst: true });
  return busyPorts.length > 0;
}

export { buildSlot, checkHasBusyPort, listBusyPorts };
export type { PortSlot };
