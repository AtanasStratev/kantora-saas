/**
 * The single list of keyboard shortcuts (design-system.md §4). The "?" help, the status
 * bar hints and the key handler all read from here, so they cannot drift apart.
 * Browser-reserved keys (Ctrl+N/T/W, F5, F11, F12, Ctrl+F, F6) are deliberately unused.
 */
export type ShortcutId =
  | 'palette'
  | 'switchCompany'
  | 'switchPeriod'
  | 'cycleTheme'
  | 'help'
  | 'goHome'
  | 'goCompanies'
  | 'goTeam'
  | 'goParameters'
  | 'goJournal'
  | 'goAccounts'
  | 'goTrialBalance'
  | 'goGeneralLedger'
  | 'goRegister'
  | 'goAnalytic'
  | 'goCounterparties'
  | 'goCostObjects'
  | 'goRates'
  | 'newEntry'
  | 'entryTemplate'
  | 'goDesign';

export type Shortcut = {
  id: ShortcutId;
  keys: string[]; // display form, e.g. ['Ctrl', 'K'] or ['g', 'f'] for a sequence
  sequence?: boolean;
  label: string;
  group: 'Общи' | 'Навигация';
};

export const SHORTCUTS: Shortcut[] = [
  {
    id: 'palette',
    keys: ['Ctrl', 'K'],
    label: 'Командна палитра: търсене на всичко',
    group: 'Общи',
  },
  { id: 'switchCompany', keys: ['Ctrl', 'Shift', 'K'], label: 'Смяна на фирма', group: 'Общи' },
  { id: 'switchPeriod', keys: ['Alt', 'P'], label: 'Смяна на период', group: 'Общи' },
  { id: 'cycleTheme', keys: ['Alt', 'T'], label: 'Смяна на темата', group: 'Общи' },
  { id: 'help', keys: ['?'], label: 'Всички клавишни комбинации', group: 'Общи' },
  { id: 'goHome', keys: ['g', 'h'], sequence: true, label: 'Към началото', group: 'Навигация' },
  { id: 'goCompanies', keys: ['g', 'f'], sequence: true, label: 'Към фирмите', group: 'Навигация' },
  {
    id: 'goTeam',
    keys: ['g', 'e'],
    sequence: true,
    label: 'Към екипа (собственик)',
    group: 'Навигация',
  },
  { id: 'newEntry', keys: ['F2'], label: 'Нова статия', group: 'Общи' },
  {
    id: 'entryTemplate',
    keys: ['F4'],
    label: 'Шаблон на статия (в „Нова статия“)',
    group: 'Общи',
  },
  { id: 'goJournal', keys: ['g', 'j'], sequence: true, label: 'Към статиите', group: 'Навигация' },
  {
    id: 'goAccounts',
    keys: ['g', 's'],
    sequence: true,
    label: 'Към сметкоплана',
    group: 'Навигация',
  },
  {
    id: 'goTrialBalance',
    keys: ['g', 't'],
    sequence: true,
    label: 'Към оборотната ведомост',
    group: 'Навигация',
  },
  {
    id: 'goGeneralLedger',
    keys: ['g', 'l'],
    sequence: true,
    label: 'Към главната книга',
    group: 'Навигация',
  },
  {
    id: 'goRegister',
    keys: ['g', 'r'],
    sequence: true,
    label: 'Към хронологичния регистър',
    group: 'Навигация',
  },
  {
    id: 'goAnalytic',
    keys: ['g', 'a'],
    sequence: true,
    label: 'Към аналитичната справка',
    group: 'Навигация',
  },
  {
    id: 'goCounterparties',
    keys: ['g', 'c'],
    sequence: true,
    label: 'Към контрагентите',
    group: 'Навигация',
  },
  {
    id: 'goCostObjects',
    keys: ['g', 'o'],
    sequence: true,
    label: 'Към обектите',
    group: 'Навигация',
  },
  {
    id: 'goRates',
    keys: ['g', 'k'],
    sequence: true,
    label: 'Към курсовете на БНБ',
    group: 'Навигация',
  },
  {
    id: 'goParameters',
    keys: ['g', 'p'],
    sequence: true,
    label: 'Към параметрите по закон',
    group: 'Навигация',
  },
  {
    id: 'goDesign',
    keys: ['g', 'd'],
    sequence: true,
    label: 'Към дизайн системата',
    group: 'Навигация',
  },
];

export function shortcut(id: ShortcutId): Shortcut {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown shortcut ${id}`);
  return s;
}

/** True when the event comes from a place where typing must not trigger shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
