const STORAGE_KEY = 'arachne.panelCollapsed';

export interface PanelToggle {
  open(): void;
}

export function createPanelToggle(app: HTMLElement, hide: HTMLButtonElement, show: HTMLButtonElement): PanelToggle {
  const set = (collapsed: boolean) => {
    app.classList.toggle('panel-collapsed', collapsed);
    show.hidden = !collapsed;
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      // Storage can be unavailable (private mode, blocked site data); the toggle still works.
    }
  };

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // As above: without storage the panel starts open.
  }
  set(collapsed);

  hide.addEventListener('click', () => set(true));
  show.addEventListener('click', () => set(false));
  document.addEventListener('keydown', (e) => {
    if (e.key !== '\\' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
    set(!app.classList.contains('panel-collapsed'));
  });

  return { open: () => set(false) };
}
