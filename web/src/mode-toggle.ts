import type { ExpandMode } from './project';

const LABELS: Record<ExpandMode, string> = { manual: 'Manual', all: 'Expand all' };

export function createModeToggle(root: HTMLElement, onChange: (mode: ExpandMode) => void): void {
  let mode: ExpandMode = 'manual';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'File expansion');
  const buttons = (Object.keys(LABELS) as ExpandMode[]).map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = LABELS[m];
    b.title = `${LABELS[m]} ( e )`;
    b.addEventListener('click', () => set(m));
    return [m, b] as const;
  });
  root.replaceChildren(...buttons.map(([, b]) => b));

  const render = () => {
    for (const [m, b] of buttons) b.setAttribute('aria-pressed', String(m === mode));
  };
  const set = (next: ExpandMode) => {
    mode = next;
    render();
    onChange(mode);
  };
  render();

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'e' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
    set(mode === 'all' ? 'manual' : 'all');
  });
}
