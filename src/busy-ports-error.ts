import type { PortSlot } from './ports';

import { PartialReleaseError } from './partial-release-error';

interface BusyPort {
  port: number;
  slot: number;
}

export class BusyPortsError extends PartialReleaseError {
  public readonly ports: Array<BusyPort>;

  public constructor(ports: Array<BusyPort>, releasedSlots: Array<PortSlot> = [], unresolvedSlots: Array<number> = []) {
    super('portsBusy', releasedSlots, unresolvedSlots);
    this.name = 'BusyPortsError';
    this.ports = ports;
  }
}

export type { BusyPort };
