/**
 * Searchable repository picker (#615). Type to filter by `owner/name`
 * (case-insensitive substring), results grouped by owner; arrow keys +
 * Enter pick, Esc closes. Used by the new-project wizard and by Workspace
 * settings' per-map picker.
 */
import { useId, useMemo, useState } from 'react';

export const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/mindblown-by-project-li/installations/new';

export interface RepoComboOption {
  /** What `onChange` receives. */
  value: string;
  fullName: string;
  /** Group heading; defaults to the owner part of `fullName`. */
  group?: string;
  /** Shown after the name, e.g. "(private)". */
  suffix?: string;
}

export function RepoCombobox({
  options,
  value,
  onChange,
  placeholder = 'Search repositories…',
  noneLabel,
  disabled,
  installHint = true,
  testId,
  style,
}: {
  options: RepoComboOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Adds an option with value '' (e.g. "No repo linked"). */
  noneLabel?: string;
  disabled?: boolean;
  /** On no match, point at installing the GitHub App on the missing org. */
  installHint?: boolean;
  testId?: string;
  style?: React.CSSProperties;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => options.filter((o) => o.fullName.toLowerCase().includes(q)),
    [options, q],
  );
  // Flat order the keyboard walks: the none option (unfiltered only), then
  // the matches grouped by owner in first-seen order.
  const groups = useMemo(() => {
    const byGroup = new Map<string, RepoComboOption[]>();
    for (const o of matches) {
      const g = o.group ?? o.fullName.split('/')[0];
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(o);
    }
    return [...byGroup.entries()];
  }, [matches]);
  const showNone = noneLabel !== undefined && q === '';
  const flat: Array<{ value: string }> = [
    ...(showNone ? [{ value: '' }] : []),
    ...groups.flatMap(([, os]) => os),
  ];

  const selected = options.find((o) => o.value === value);
  const shown = open ? query : selected ? selected.fullName : value ? value : (noneLabel ?? '');

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(0); return; }
      if (flat.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + step + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      const o = flat[active];
      if (o) pick(o.value);
    } else if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery('');
    }
  };

  let idx = 0;
  const optionEl = (v: string, label: React.ReactNode, key: string) => {
    const i = idx++;
    const isActive = i === active;
    return (
      <li
        key={key}
        id={`${listId}-${i}`}
        role="option"
        aria-selected={v === value}
        // mousedown keeps focus on the input, so blur doesn't close first.
        onMouseDown={(e) => { e.preventDefault(); pick(v); }}
        onMouseEnter={() => setActive(i)}
        style={{
          padding: '6px 10px 6px 18px', fontSize: 13, cursor: 'pointer', color: '#1e293b',
          background: isActive ? '#eff6ff' : 'transparent',
          fontWeight: v === value ? 600 : 400,
        }}
      >
        {label}
      </li>
    );
  };

  return (
    <div style={{ position: 'relative', ...style }}>
      <input
        type="text"
        role="combobox"
        data-testid={testId}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && flat[active] ? `${listId}-${active}` : undefined}
        value={shown}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => { setOpen(true); setQuery(''); setActive(0); }}
        onClick={() => setOpen(true)}
        onBlur={() => { setOpen(false); setQuery(''); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={onKeyDown}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '8px 10px',
          border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
          color: '#1e293b', background: '#fff',
        }}
      />
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, marginTop: 2,
            maxHeight: 260, overflow: 'auto', background: '#fff',
            border: '1px solid #e2e8f0', borderRadius: 6, boxShadow: '0 8px 20px rgba(15,23,42,0.12)',
          }}
        >
          {flat.length === 0 ? (
            <div data-testid="repo-combobox-empty" style={{ padding: '8px 10px', fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>
              {installHint ? (
                <>
                  No repo matches — is the MindBlown GitHub App installed on that org?{' '}
                  <a
                    href={GITHUB_APP_INSTALL_URL}
                    target="_blank"
                    rel="noreferrer"
                    onMouseDown={(e) => e.preventDefault()}
                    style={{ color: '#2563eb' }}
                  >
                    Install the App
                  </a>
                </>
              ) : 'No repo matches.'}
            </div>
          ) : (
            <ul id={listId} role="listbox" style={{ listStyle: 'none', margin: 0, padding: '4px 0' }}>
              {showNone && optionEl('', <em style={{ color: '#64748b' }}>{noneLabel}</em>, '__none')}
              {groups.map(([g, os]) => (
                <li key={`g:${g}`} role="presentation">
                  <div
                    aria-hidden="true"
                    style={{ padding: '6px 10px 2px', fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}
                  >
                    {g}
                  </div>
                  <ul role="group" aria-label={g} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {os.map((o) => optionEl(
                      o.value,
                      <>{o.fullName}{o.suffix ? <span style={{ color: '#94a3b8' }}> {o.suffix}</span> : null}</>,
                      o.value,
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
