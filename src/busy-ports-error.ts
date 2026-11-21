import type { PortSlot } from './ports';

import { PortoError } from './error';

interface BusyPort {
  port: number;
  slot: number;
}

export class BusyPortsError extends PortoError {
  public readonly ports: Array<BusyPort>;
  public readonly releasedSlots: Array<PortSlot>;

  public constructor(ports: Array<BusyPort>, releasedSlots: Array<PortSlot> = []) {
    super('portsBusy');
    this.name = 'BusyPortsError';
    this.ports = ports;
    this.releasedSlots = releasedSlots;
  }
}

export type { BusyPort };
