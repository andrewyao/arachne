export interface MenuItem {
  label: string;
  detail?: string;
  run(): void;
}

export interface ContextMenu {
  open(x: number, y: number, title: string, items: MenuItem[]): void;
  close(): void;
}

const EDGE = 8;

export function createContextMenu(): ContextMenu {
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.append(menu);

  let buttons: HTMLButtonElement[] = [];
  let restoreFocus: HTMLElement | null = null;

  const close = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    buttons = [];
    restoreFocus?.focus({ preventScroll: true });
  };

  const move = (step: number) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + step + buttons.length) % buttons.length]?.focus();
  };

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      move(e.shiftKey ? -1 : 1);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      e.preventDefault();
      close();
    }
  });
  // A press on the graph canvas that dismisses the menu is consumed, so it neither selects nor
  // expands what happens to be under it. Captured before the graph's own listeners see it.
  let swallow = false;
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (menu.hidden || menu.contains(e.target as Node)) return;
      close();
      if (!(e.target instanceof HTMLCanvasElement)) return;
      swallow = true;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  for (const type of ['pointerup', 'click'] as const) {
    document.addEventListener(
      type,
      (e) => {
        if (!swallow) return;
        e.stopPropagation();
        if (type === 'click') swallow = false;
        // A release off the canvas fires no click; don't let the flag eat a later one.
        else setTimeout(() => (swallow = false));
      },
      true,
    );
  }
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  document.addEventListener('wheel', close, { passive: true });

  return {
    close,
    open(x, y, title, items) {
      restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const head = document.createElement('p');
      head.className = 'context-title';
      head.textContent = title;
      buttons = items.map((item) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        const label = document.createElement('span');
        label.textContent = item.label;
        b.append(label);
        if (item.detail) {
          const detail = document.createElement('span');
          detail.className = 'context-detail';
          detail.textContent = item.detail;
          b.append(detail);
        }
        b.addEventListener('click', () => {
          close();
          item.run();
        });
        return b;
      });
      menu.replaceChildren(head, ...buttons);
      menu.hidden = false;
      const { width, height } = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(EDGE, Math.min(x, innerWidth - width - EDGE))}px`;
      menu.style.top = `${Math.max(EDGE, Math.min(y, innerHeight - height - EDGE))}px`;
      buttons[0]?.focus({ preventScroll: true });
    },
  };
}
