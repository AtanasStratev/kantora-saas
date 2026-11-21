'use client';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type Column<T> = {
  key: string;
  header: string;
  width: number;
  align?: 'left' | 'right';
  cell: (row: T) => ReactNode;
};

const ROW_HEIGHT = 28; // design-system.md: dense row

/**
 * Virtualized table for 100 000+ rows: only visible rows are in the DOM.
 * Keyboard: ↑/↓ move, PageUp/PageDown jump, Home/End go to the ends, Enter opens.
 */
export function DataTable<T>({
  rows,
  columns,
  label,
  height = 360,
  onOpen,
}: {
  rows: T[];
  columns: Column<T>[];
  label: string;
  height?: number;
  onOpen?: (row: T, index: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const width = columns.reduce((s, c) => s + c.width, 0);
  const pageRows = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1);

  function move(to: number) {
    const next = Math.max(0, Math.min(rows.length - 1, to));
    setActive(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(active + 1),
      ArrowUp: () => move(active - 1),
      PageDown: () => move(active + pageRows),
      PageUp: () => move(active - pageRows),
      Home: () => move(0),
      End: () => move(rows.length - 1),
      Enter: () => {
        const r = rows[active];
        if (r !== undefined) onOpen?.(r, active);
      },
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  }

  return (
    <div className="rounded border border-line">
      <div
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-label={label}
        aria-rowcount={rows.length + 1}
        aria-activedescendant={rows.length ? `${label}-row-${active}` : undefined}
        onKeyDown={onKeyDown}
        style={{ height }}
        className="overflow-auto"
      >
        <div style={{ width, minWidth: '100%' }}>
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-10 flex border-b border-line-strong bg-surface-raised text-xs text-fg-muted"
          >
            {columns.map((c) => (
              <div
                key={c.key}
                role="columnheader"
                style={{ width: c.width }}
                className={`px-2 py-1 ${c.align === 'right' ? 'text-right' : ''}`}
              >
                {c.header}
              </div>
            ))}
          </div>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index];
              if (row === undefined) return null;
              const isActive = v.index === active;
              return (
                <div
                  key={v.key}
                  id={`${label}-row-${v.index}`}
                  role="row"
                  aria-rowindex={v.index + 2}
                  aria-selected={isActive}
                  onClick={() => setActive(v.index)}
                  onDoubleClick={() => onOpen?.(row, v.index)}
                  style={{
                    position: 'absolute',
                    top: 0,
                    transform: `translateY(${v.start}px)`,
                    height: ROW_HEIGHT,
                  }}
                  className={`flex w-full items-center border-b border-line text-[13px] ${
                    isActive ? 'bg-surface-selected' : v.index % 2 ? 'bg-surface-sunken' : ''
                  }`}
                >
                  {columns.map((c) => (
                    <div
                      key={c.key}
                      role="gridcell"
                      style={{ width: c.width }}
                      className={`truncate px-2 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}
                    >
                      {c.cell(row)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="border-t border-line px-2 py-1 text-xs text-fg-muted">
        Ред {rows.length ? (active + 1).toLocaleString('bg-BG') : 0} от{' '}
        {rows.length.toLocaleString('bg-BG')}
      </div>
    </div>
  );
}
