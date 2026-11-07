import { PortoError } from './error';

export class BusyPortsError extends PortoError {
  public readonly ports: { block: number; port: number }[];

  public constructor(ports: { block: number; port: number }[]) {
    super('portsBusy');
    this.name = 'BusyPortsError';
    this.ports = ports;
  }
}
