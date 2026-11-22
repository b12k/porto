import type { PortSlot } from './ports';

import { PortoError } from './error';

export class PartialReleaseError extends PortoError {
  public readonly releasedSlots: Array<PortSlot>;
  public readonly unresolvedSlots: Array<number>;

  public constructor(
    code: 'hostUnresolved' | 'portsBusy',
    releasedSlots: Array<PortSlot>,
    unresolvedSlots: Array<number>,
  ) {
    super(
      code,
      unresolvedSlots.length > 0
        ? `Slots left in place with an unverified host: ${unresolvedSlots.join(', ')}`
        : undefined,
    );
    this.name = 'PartialReleaseError';
    this.releasedSlots = releasedSlots;
    this.unresolvedSlots = unresolvedSlots;
  }
}
