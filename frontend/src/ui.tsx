/**
 * Small parts used on every screen: floating windows, menus, notices, switches, choice strips,
 * chips, status labels. They follow mockups/overlays.html.
 */
import {
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link } from 'react-router-dom';
import { initials } from './format';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A floating window over a dimmed page. Esc closes it, Tab stays inside it, and focus returns where it was. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  size,
  alert = false,
  className = '',
}: {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'wide' | 'xl';
  /** A warning that must be answered: clicking outside does not close it. */
  alert?: boolean;
  className?: string;
}) {
  const id = useId();
  const box = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const node = box.current;
    if (node && !node.contains(document.activeElement)) {
      const first = node.querySelector<HTMLElement>('[data-autofocus]') ?? node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus();
    }
    return () => before?.focus?.();
  }, []);
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close.current();
    }
    if (event.key === 'Tab' && box.current) {
      const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? index <= 0
          ? items.length - 1
          : index - 1
        : index === items.length - 1
          ? 0
          : index + 1;
      if (index === -1 || (event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1)) {
        event.preventDefault();
        items[next].focus();
      }
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (!alert && event.target === event.currentTarget) close.current();
      }}
    >
      <section
        ref={box}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={title ? id : undefined}
        tabIndex={-1}
        className={`dialog ${size ?? ''} ${className}`}
        onKeyDown={onKeyDown}
      >
        {title && (
          <header>
            <h2 id={id}>{title}</h2>
            {!alert && (
              <button type="button" className="x" aria-label="Close this window" onClick={() => close.current()}>
                ✕
              </button>
            )}
          </header>
        )}
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  );
}

export type MenuItem =
  | 'sep'
  | { heading: string }
  | {
      label: ReactNode;
      onSelect?: () => void;
      to?: string;
      danger?: boolean;
      kbd?: string;
      disabled?: boolean;
      newTab?: boolean;
    };

/** A button that opens a short list of actions under it. */
export function Menu({
  label,
  items,
  className = 'secondary',
  ariaLabel,
  align = 'right',
}: {
  label: ReactNode;
  items: MenuItem[];
  className?: string;
  ariaLabel?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const outside = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const entries = Array.from(list.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
    const index = entries.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      anchor.current?.querySelector('button')?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      entries[(index + step + entries.length) % entries.length]?.focus();
    } else if (event.key === 'Tab') setOpen(false);
  }
  return (
    <span className="menu-anchor" ref={anchor}>
      <button
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <div className={`menu pop-menu ${align === 'left' ? 'left' : ''}`} role="menu" ref={list} onKeyDown={onKeyDown}>
          {items.map((item, index) => {
            if (item === 'sep') return <div className="sep" role="separator" key={index} />;
            if ('heading' in item)
              return (
                <div className="hd" key={index}>
                  {item.heading}
                </div>
              );
            const inside = (
              <>
                <span>{item.label}</span>
                {item.kbd && <span className="kbd">{item.kbd}</span>}
              </>
            );
            const tone = item.danger ? 'danger-item' : undefined;
            if (item.to)
              return (
                <Link
                  role="menuitem"
                  className={tone}
                  key={index}
                  to={item.to}
                  target={item.newTab ? '_blank' : undefined}
                  rel={item.newTab ? 'noreferrer' : undefined}
                  onClick={() => setOpen(false)}
                >
                  {inside}
                </Link>
              );
            return (
              <button
                type="button"
                role="menuitem"
                className={tone}
                key={index}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {inside}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

/* ---------- Notices in the bottom corner ---------- */

export interface Notice {
  id: number;
  text: string;
  kind?: 'failed' | 'offline';
  action?: { label: string; run: () => void };
  sticky?: boolean;
}
let notices: Notice[] = [];
let nextNotice = 1;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

export function dismissNotice(id: number) {
  notices = notices.filter((notice) => notice.id !== id);
  changed();
}

/** Show a short notice in the bottom corner. It fades after a few seconds unless it is sticky. */
export function notify(text: string, options: Omit<Notice, 'id' | 'text'> = {}) {
  const notice = { id: nextNotice++, text, ...options };
  notices = [...notices.filter((old) => old.text !== text), notice].slice(-4);
  changed();
  if (!options.sticky) window.setTimeout(() => dismissNotice(notice.id), options.action ? 8000 : 4000);
  return notice.id;
}
export const notifyFailed = (text: string, action?: Notice['action']) => notify(text, { kind: 'failed', action });

/** For tests: start with an empty corner. */
export function clearNotices() {
  notices = [];
  changed();
}

export function Notices() {
  const list = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notices,
  );
  return (
    <div id="toast-host" role="status" aria-live="polite">
      {list.map((notice) => (
        <div className={`toast ${notice.kind ?? ''}`} key={notice.id}>
          <span>{notice.text}</span>
          {notice.action && (
            <button
              type="button"
              onClick={() => {
                dismissNotice(notice.id);
                notice.action!.run();
              }}
            >
              {notice.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Tells the person when the computer has lost its connection, and when it is back. */
export function useOfflineNotice() {
  useEffect(() => {
    let shown: number | null = null;
    const offline = () => {
      if (shown === null)
        shown = notify('You are offline. Changes will not be saved.', { kind: 'offline', sticky: true });
    };
    const online = () => {
      if (shown !== null) dismissNotice(shown);
      shown = null;
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    if (navigator.onLine === false) offline();
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      online();
    };
  }, []);
}

/* ---------- Small controls ---------- */

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    />
  );
}

/** One row of the kind used for settings: a switch or control, a title and a line of explanation. */
export function SettingRow({
  title,
  hint,
  control,
  after,
}: {
  title: ReactNode;
  hint?: ReactNode;
  control?: ReactNode;
  after?: ReactNode;
}) {
  return (
    <div className="setting">
      {control}
      <div>
        <strong>{title}</strong>
        {hint && <span className="muted">{hint}</span>}
      </div>
      {after}
    </div>
  );
}

export function ChoiceStrip<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <span className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([key, text]) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === key}
          className={value === key ? 'on' : ''}
          key={key}
          disabled={disabled}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </span>
  );
}

export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

export type Tone = 'green' | 'amber' | 'red' | 'grey' | 'blue';
export const StatusLabel = ({ tone = 'blue', children }: { tone?: Tone; children: ReactNode }) => (
  <span className={`badge ${tone === 'blue' ? '' : `b-${tone}`}`}>{children}</span>
);

export const Avatar = ({ name, large }: { name: string; large?: boolean }) => (
  <span className={`avatar ${large ? 'large' : ''}`} aria-hidden="true">
    {initials(name)}
  </span>
);

export const Kbd = ({ children }: { children: ReactNode }) => <span className="kbd">{children}</span>;

/** Run a function when a key combination is pressed anywhere, for example Ctrl K. */
export function useShortcut(key: string, run: () => void, options: { ctrl?: boolean; active?: boolean } = {}) {
  const handler = useRef(run);
  handler.current = run;
  const { ctrl = false, active = true } = options;
  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      if (ctrl !== (event.ctrlKey || event.metaKey) || event.altKey) return;
      if (!ctrl) {
        const target = event.target as HTMLElement | null;
        if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      }
      event.preventDefault();
      handler.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, ctrl, active]);
}

/** Load something from the server, with the loading and error states every screen needs. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [turn, setTurn] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    loader
      .current(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((e) => {
        if (e.name !== 'AbortError' && !controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, turn]);
  const reload = useCallback(() => setTurn((value) => value + 1), []);
  return { data, setData, error, loading, reload };
}
