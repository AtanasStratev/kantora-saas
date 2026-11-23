'use client';
import * as RD from '@radix-ui/react-dialog';
import { can, isRole, matchScore } from '@kantora/domain';
import { Command } from 'cmdk';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Kbd } from '@/components/ui';
import type { AppContext } from '@/lib/context';
import { periodLabel } from '@/lib/period';
import { authClient } from '@/lib/auth-client';
import { isTypingTarget, SHORTCUTS, shortcut, type ShortcutId } from '@/shortcuts/registry';
import { applyTheme } from '@/theme/ThemeHotkey';
import { THEME_LABEL, THEMES } from '@/theme/theme';
import { selectCompany, selectOffice, selectPeriod } from './context-actions';

const NAV = [
  { href: '/', label: 'Начало', key: 'goHome' as const },
  { href: '/companies', label: 'Фирми', key: 'goCompanies' as const },
  { href: '/journal', label: 'Статии', key: 'goJournal' as const },
  { href: '/reports/trial-balance', label: 'Оборотна ведомост', key: 'goTrialBalance' as const },
  { href: '/reports/general-ledger', label: 'Главна книга', key: 'goGeneralLedger' as const },
  { href: '/reports/register', label: 'Хронологичен регистър', key: 'goRegister' as const },
  { href: '/accounts', label: 'Сметкоплан', key: 'goAccounts' as const },
  { href: '/rates', label: 'Курсове', key: 'goRates' as const },
  { href: '/parameters', label: 'Параметри', key: 'goParameters' as const },
  { href: '/team', label: 'Екип', key: 'goTeam' as const, ownerOnly: true },
];

type PaletteMode = 'all' | 'company' | 'period';

function Keys({ id }: { id: ShortcutId }) {
  const s = shortcut(id);
  return (
    <span className="inline-flex gap-0.5">
      {s.keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

export function Shell({ ctx, children }: { ctx: AppContext; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [help, setHelp] = useState(false);
  const pendingG = useRef<number | null>(null);

  const go = useCallback((href: string) => router.push(href), [router]);
  const role = ctx.office?.role;
  const nav = NAV.filter((n) => !('ownerOnly' in n) || (isRole(role) && can(role, 'team.manage')));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && e.code === 'KeyK') {
        e.preventDefault();
        setPalette('company');
        return;
      }
      if (ctrl && !e.shiftKey && e.code === 'KeyK') {
        e.preventDefault();
        setPalette('all');
        return;
      }
      if (e.altKey && !ctrl && e.code === 'KeyP') {
        e.preventDefault();
        if (ctx.company) setPalette('period');
        return;
      }
      // F2 types nothing, so it works from inside a field too, except on the entry screen
      // itself, where it would throw away what is being typed.
      if (e.key === 'F2' && !ctrl && !e.altKey && ctx.company) {
        e.preventDefault();
        if (pathname !== '/journal/new') go('/journal/new');
        return;
      }
      if (isTypingTarget(e.target) || ctrl || e.altKey) return;
      // "?" on any layout: the character itself, or Shift + the physical "/" key.
      if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) {
        e.preventDefault();
        setHelp(true);
        return;
      }
      // Two-key navigation "g" then a letter, by PHYSICAL key (e.code), so it works the
      // same with a Bulgarian (Cyrillic) keyboard layout, where "g" types "г".
      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        const target = {
          KeyH: '/',
          KeyF: '/companies',
          KeyD: '/design',
          KeyE: '/team',
          KeyP: '/parameters',
          KeyJ: '/journal',
          KeyS: '/accounts',
          KeyT: '/reports/trial-balance',
          KeyL: '/reports/general-ledger',
          KeyR: '/reports/register',
          KeyK: '/rates',
        }[e.code];
        if (target) {
          e.preventDefault();
          go(target);
        }
        return;
      }
      if (e.code === 'KeyG' && !e.shiftKey) {
        pendingG.current = window.setTimeout(() => (pendingG.current = null), 1200);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctx.company, go, pathname]);

  async function choose(action: () => Promise<void>) {
    setPalette(null);
    await action();
    router.refresh();
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-line-strong bg-surface-raised px-4 py-2">
        <span className="font-semibold">Кантора</span>
        <span className="text-fg-muted">{ctx.office?.name}</span>
        <button
          type="button"
          onClick={() => setPalette('company')}
          className="rounded border border-line px-2 py-0.5"
          // The accessible name starts with the visible text (WCAG 2.5.3).
          aria-label={`${ctx.company ? ctx.company.name : 'Изберете фирма'}: смяна на фирма`}
          aria-keyshortcuts="Control+Shift+K"
        >
          {ctx.company ? ctx.company.name : 'Изберете фирма'}
        </button>
        {ctx.company ? (
          <button
            type="button"
            onClick={() => setPalette('period')}
            className="rounded border border-line px-2 py-0.5"
            aria-label={`${ctx.period ? periodLabel(ctx.period) : 'Няма период'}: смяна на период`}
            aria-keyshortcuts="Alt+P"
          >
            {ctx.period ? periodLabel(ctx.period) : 'Няма период'}
          </button>
        ) : null}
        {ctx.period ? (
          <span className="text-xs text-fg-muted" title="Отчетна валута на годината">
            {ctx.period.ledgerCurrency}
          </span>
        ) : null}
        {ctx.period?.locked ? <Badge kind="locked" /> : null}
        <span className="ml-auto flex items-center gap-3 text-xs text-fg-muted">
          <button type="button" onClick={() => setPalette('all')} className="underline">
            Търсене <Keys id="palette" />
          </button>
          <button type="button" onClick={() => setHelp(true)} className="underline">
            Клавиши <Keys id="help" />
          </button>
          <Link href="/account" className="underline" title="Профил и активни сесии">
            {ctx.user.name}
          </Link>
        </span>
      </header>

      <div className="flex flex-1">
        <nav
          aria-label="Основна навигация"
          className="w-48 border-r border-line bg-surface-raised p-2"
        >
          <ul className="flex flex-col gap-1">
            {nav.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={pathname === n.href ? 'page' : undefined}
                  className="flex justify-between gap-2 rounded px-2 py-1 aria-[current=page]:bg-surface-selected"
                >
                  {n.label}
                  <span className="shrink-0 whitespace-nowrap text-xs text-fg-muted">
                    {shortcut(n.key).keys.join(' ')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main className="flex-1 p-6">{children}</main>
      </div>

      <footer className="flex gap-4 border-t border-line bg-surface-raised px-4 py-1 text-xs text-fg-muted">
        <span>
          <Keys id="palette" /> търсене
        </span>
        <span>
          <Keys id="switchCompany" /> фирма
        </span>
        <span>
          <Keys id="switchPeriod" /> период
        </span>
        <span>
          <Keys id="cycleTheme" /> тема
        </span>
        <span>
          <Keys id="help" /> всички клавиши
        </span>
      </footer>

      <Palette
        mode={palette}
        nav={nav}
        ctx={ctx}
        onClose={() => setPalette(null)}
        onCompany={(id) => choose(() => selectCompany(id))}
        onPeriod={(id) => choose(() => selectPeriod(id))}
        onOffice={(id) => choose(() => selectOffice(id))}
        onNavigate={(href) => {
          setPalette(null);
          go(href);
        }}
        onHelp={() => {
          setPalette(null);
          setHelp(true);
        }}
        onSignOut={async () => {
          setPalette(null);
          await authClient.signOut();
          router.push('/login');
          router.refresh();
        }}
      />
      <HelpDialog open={help} onOpenChange={setHelp} />
    </div>
  );
}

const PLACEHOLDER: Record<PaletteMode, string> = {
  all: 'Търсене на фирма, период, страница или действие…',
  company: 'Име или ЕИК на фирмата (кирилица или латиница)…',
  period: 'Месец или година…',
};

function Palette({
  mode,
  nav,
  ctx,
  onClose,
  onCompany,
  onPeriod,
  onOffice,
  onNavigate,
  onHelp,
  onSignOut,
}: {
  mode: PaletteMode | null;
  nav: typeof NAV;
  ctx: AppContext;
  onClose: () => void;
  onCompany: (id: string) => void;
  onPeriod: (id: string) => void;
  onOffice: (id: string) => void;
  onNavigate: (href: string) => void;
  onHelp: () => void;
  onSignOut: () => void;
}) {
  const show = (m: PaletteMode) => mode === 'all' || mode === m;
  const itemCls =
    'flex cursor-default justify-between rounded px-2 py-1 data-[selected=true]:bg-surface-selected';
  return (
    <Command.Dialog
      open={mode !== null}
      onOpenChange={(o) => !o && onClose()}
      label="Командна палитра"
      filter={(value, search, keywords) =>
        matchScore([value, ...(keywords ?? [])].join(' '), search) / 100
      }
      overlayClassName="fixed inset-0 z-40 bg-overlay"
      contentClassName="fixed top-24 left-1/2 z-50 w-[36rem] max-w-[92vw] -translate-x-1/2 rounded border border-line-strong bg-surface-raised text-fg shadow-lg"
    >
      <Command.Input
        placeholder={mode ? PLACEHOLDER[mode] : ''}
        className="w-full border-b border-line bg-transparent px-3 py-2 outline-none"
      />
      <Command.List className="max-h-80 overflow-auto p-1">
        <Command.Empty className="px-3 py-2 text-sm text-fg-muted">
          Нищо не е намерено. Проверете правописа или опитайте с ЕИК.
        </Command.Empty>

        {show('company') ? (
          <Command.Group
            heading="Фирми"
            className="text-xs text-fg-muted [&_[cmdk-item]]:text-sm [&_[cmdk-item]]:text-fg"
          >
            {ctx.companies.length === 0 ? (
              <Command.Item
                value="__new-company"
                onSelect={() => onNavigate('/companies')}
                className={itemCls}
              >
                Още няма фирми — създайте първата
              </Command.Item>
            ) : null}
            {ctx.companies.map((c) => (
              <Command.Item
                key={c.id}
                value={`company-${c.id}`}
                keywords={[c.name, c.eik ?? '']}
                onSelect={() => onCompany(c.id)}
                className={itemCls}
              >
                <span>{c.name}</span>
                <span className="text-xs text-fg-muted">
                  {c.eik ?? ''} {ctx.company?.id === c.id ? '· текуща' : ''}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {show('period') && ctx.periods.length > 0 ? (
          <Command.Group
            heading="Периоди"
            className="text-xs text-fg-muted [&_[cmdk-item]]:text-sm [&_[cmdk-item]]:text-fg"
          >
            {ctx.periods.map((p) => (
              <Command.Item
                key={p.id}
                value={`period-${p.id}`}
                keywords={[periodLabel(p), String(p.year), `${p.month}.${p.year}`]}
                onSelect={() => onPeriod(p.id)}
                className={itemCls}
              >
                <span>{periodLabel(p)}</span>
                <span className="text-xs text-fg-muted">
                  {p.ledgerCurrency}
                  {p.locked ? ' · заключен' : ''}
                  {ctx.period?.id === p.id ? ' · текущ' : ''}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {mode === 'all' ? (
          <>
            {ctx.offices.length > 1 ? (
              <Command.Group
                heading="Кантори"
                className="text-xs text-fg-muted [&_[cmdk-item]]:text-sm [&_[cmdk-item]]:text-fg"
              >
                {ctx.offices.map((o) => (
                  <Command.Item
                    key={o.id}
                    value={`office-${o.id}`}
                    keywords={[o.name]}
                    onSelect={() => onOffice(o.id)}
                    className={itemCls}
                  >
                    {o.name}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            <Command.Group
              heading="Страници"
              className="text-xs text-fg-muted [&_[cmdk-item]]:text-sm [&_[cmdk-item]]:text-fg"
            >
              {[...nav, { href: '/design', label: 'Дизайн система', key: 'goDesign' as const }].map(
                (n) => (
                  <Command.Item
                    key={n.href}
                    value={`nav-${n.href}`}
                    keywords={[n.label]}
                    onSelect={() => onNavigate(n.href)}
                    className={itemCls}
                  >
                    <span>{n.label}</span>
                    <span className="text-xs text-fg-muted">{shortcut(n.key).keys.join(' ')}</span>
                  </Command.Item>
                ),
              )}
            </Command.Group>
            <Command.Group
              heading="Действия"
              className="text-xs text-fg-muted [&_[cmdk-item]]:text-sm [&_[cmdk-item]]:text-fg"
            >
              <Command.Item
                value="action-new-company"
                keywords={['нова фирма', 'създай фирма']}
                onSelect={() => onNavigate('/companies')}
                className={itemCls}
              >
                Нова фирма
              </Command.Item>
              {THEMES.map((t) => (
                <Command.Item
                  key={t}
                  value={`theme-${t}`}
                  keywords={[`тема ${THEME_LABEL[t]}`]}
                  onSelect={() => {
                    applyTheme(t);
                    onClose();
                  }}
                  className={itemCls}
                >
                  Тема: {THEME_LABEL[t]}
                </Command.Item>
              ))}
              <Command.Item
                value="action-account"
                keywords={['профил', 'сесии', 'устройства', 'парола']}
                onSelect={() => onNavigate('/account')}
                className={itemCls}
              >
                Профил и активни сесии
              </Command.Item>
              <Command.Item
                value="action-help"
                keywords={['клавиши', 'помощ']}
                onSelect={onHelp}
                className={itemCls}
              >
                <span>Клавишни комбинации</span>
                <Keys id="help" />
              </Command.Item>
              <Command.Item
                value="action-signout"
                keywords={['изход']}
                onSelect={onSignOut}
                className={itemCls}
              >
                Изход
              </Command.Item>
            </Command.Group>
          </>
        ) : null}
      </Command.List>
    </Command.Dialog>
  );
}

function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <RD.Content className="fixed top-20 left-1/2 z-50 w-[32rem] max-w-[92vw] -translate-x-1/2 rounded border border-line-strong bg-surface-raised p-5 text-fg">
          <RD.Title className="mb-1 text-lg font-semibold">Клавишни комбинации</RD.Title>
          <RD.Description className="mb-4 text-sm text-fg-muted">
            Всичко в системата работи без мишка. Esc затваря този прозорец.
          </RD.Description>
          {groups.map((g) => (
            <section key={g} className="mb-4">
              <h3 className="mb-1 text-xs text-fg-muted">{g}</h3>
              <ul className="flex flex-col gap-1">
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <li key={s.id} className="flex justify-between text-sm">
                    <span>{s.label}</span>
                    <span className="inline-flex gap-0.5">
                      {s.keys.map((k, i) => (
                        <Kbd key={i}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
