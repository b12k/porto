import { PortoError } from './error';

export class BusyPortsError extends PortoError {
  public readonly ports: Array<{ port: number; slot: number }>;

  public constructor(ports: Array<{ port: number; slot: number }>) {
    super('portsBusy');
    this.name = 'BusyPortsError';
    this.ports = ports;
  }
}
