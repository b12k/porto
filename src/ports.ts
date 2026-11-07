import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';

import { PortoError } from './error';

export function buildBlock(record: { index: number; size: number; start: number }) {
  const start = record.start + record.index * record.size;
  return {
    end: start + record.size - 1,
    getPort(offset = 0) {
      if (!Number.isInteger(offset) || offset < 0 || offset >= record.size) {
        throw new PortoError('offsetInvalid', `offset must be an integer between 0 and ${record.size - 1}.`);
      }
      return start + offset;
    },
    index: record.index,
    start,
  };
}

async function checkIsAddressAvailable(port: number, host: string) {
  // Node's TCP listen/close API uses callbacks.
  // oxlint-disable-next-line promise/avoid-new
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else if (host.includes(':') && (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL')) resolve(true);
      else reject(error);
    });
    server.listen({ exclusive: true, host, ipv6Only: true, port }, () => {
      // oxlint-disable-next-line promise/prefer-await-to-callbacks
      server.close((error) => {
        if (error) reject(error);
        else resolve(true);
      });
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

export async function listBusyPorts(start: number, end: number) {
  const busyPorts: number[] = [];
  const hosts = getProbeHosts();
  for (let port = start; port <= end; port += 1) {
    // Windows can bind wildcard sockets alongside listeners on a specific interface.
    for (const host of hosts) {
      // These probes must not collide with sockets opened by another probe.
      // oxlint-disable-next-line no-await-in-loop
      if (!(await checkIsAddressAvailable(port, host))) {
        busyPorts.push(port);
        break;
      }
    }
  }
  return busyPorts;
}
