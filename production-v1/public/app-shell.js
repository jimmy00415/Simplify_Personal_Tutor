const TABS = Object.freeze(['today', 'campus', 'practice', 'translate']);
const CAMPUS_IDS = Object.freeze(['message-list', 'turn-status', 'composer']);

export function createAppShell({
  root,
  tabButtons,
  views,
  campusNodes,
} = {}) {
  let current = 'campus';

  function show(tab) {
    const next = TABS.includes(tab) ? tab : 'campus';
    current = next;
    root?.setAttribute('data-tab', next);
    for (const button of tabButtons ?? []) {
      const selected = button.dataset.tab === next;
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    for (const [name, node] of Object.entries(views ?? {})) {
      if (!node) continue;
      node.hidden = name !== next;
    }
    for (const node of campusNodes ?? []) {
      if (!node) continue;
      node.hidden = next !== 'campus';
    }
    return next;
  }

  for (const button of tabButtons ?? []) {
    button.addEventListener('click', () => show(button.dataset.tab));
  }

  return {
    show,
    current: () => current,
    tabs: TABS,
    campusIds: CAMPUS_IDS,
  };
}
