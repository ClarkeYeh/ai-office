import { useNow, useViewModel } from '../../../realtime/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import {
  boardViewModel,
  officeViewModel,
  type SelectorArgs,
} from '../model/index.js';

type ReadModel = Parameters<typeof officeViewModel>[0];

const office = (model: ReadModel | null, args: SelectorArgs) =>
  model ? officeViewModel(model, args) : null;
const board = (model: ReadModel | null, args: SelectorArgs) =>
  model ? boardViewModel(model, args) : null;
export function useOfficeViewModel(selectedSeatId: string | null = null) {
  return useViewModel(office, { now: useNow(), t, selectedSeatId });
}
export function useBoardViewModel(selectedSeatId: string | null = null) {
  return useViewModel(board, { now: useNow(), t, selectedSeatId });
}
