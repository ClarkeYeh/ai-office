/** Structural PP2 seam until M2-T2 lands; accepts its AdapterStateStore unchanged. */
export interface AdapterState {
  read(scope: string): unknown | null;
  write(scope: string, value: unknown): void;
}
