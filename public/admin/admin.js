for (const field of document.querySelectorAll('[data-rich-text]')) {
  const value = field.querySelector('[data-rich-value]');
  const controls = field.querySelector('[data-rich-controls]');
  const editor = field.querySelector('[data-rich-editor]');
  value.closest('label').hidden = true;
  controls.hidden = false;
  const sync = () => { value.value = editor.innerHTML; };
  editor.addEventListener('input', sync);
  editor.addEventListener('paste', (event) => {
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    sync();
  });
  for (const button of controls.querySelectorAll('[data-command]')) {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      editor.focus();
      document.execCommand(button.dataset.command, false, button.dataset.argument ?? null);
      sync();
    });
  }
}

const activation = document.querySelector('[data-owner-activation]');
if (activation) {
  const field = activation.elements.namedItem('token');
  const token = field.value || new URLSearchParams(location.hash.slice(1)).get('token') || '';
  if (/^[0-9a-f]{64}$/.test(token)) {
    field.value = token;
    activation.querySelector('button').disabled = false;
    activation.querySelector('[data-activation-help]').hidden = true;
  }
}

const menu = document.querySelector('[data-admin-menu]');
if (menu) {
  menu.hidden = false;
  const isOpen = () => menu.getAttribute('aria-expanded') === 'true';
  menu.addEventListener('click', () => menu.setAttribute('aria-expanded', String(!isOpen())));
  const sidebar = document.getElementById(menu.getAttribute('aria-controls'));
  sidebar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      menu.setAttribute('aria-expanded', 'false');
      menu.focus();
    }
  });
}

const searches = document.querySelectorAll('[data-admin-search]');
const dialog = document.querySelector('[data-admin-search-dialog]');
if (searches.length && typeof dialog?.showModal === 'function') {
  const input = dialog.querySelector('input');
  const items = [...dialog.querySelectorAll('[data-search-item]')];
  const empty = dialog.querySelector('[data-search-empty]');
  function filterPages() {
    const query = input.value.trim().toLowerCase();
    for (const item of items) item.hidden = !item.textContent.toLowerCase().includes(query);
    empty.hidden = items.some((item) => !item.hidden);
  }
  function openSearch() {
    if (dialog.open) return;
    input.value = '';
    filterPages();
    dialog.showModal();
    input.focus();
  }
  for (const search of searches) {
    search.hidden = false;
    search.addEventListener('click', openSearch);
  }
  input.addEventListener('input', filterPages);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') items.find((item) => !item.hidden)?.querySelector('a').click();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    }
  });
}

for (const picker of document.querySelectorAll('[data-report-picker]')) {
  const form = picker.querySelector('[data-report-form]');
  const comparisonDates = form.querySelector('[data-comparison-dates]');
  form.addEventListener('change', () => {
    const custom = form.elements.namedItem('compare').value === 'custom';
    comparisonDates.hidden = !custom;
    for (const input of comparisonDates.querySelectorAll('input')) input.disabled = !custom;
    const from = form.elements.namedItem('start');
    const to = form.elements.namedItem('end');
    to.min = from.value || '2000-01-01';
    from.setCustomValidity(from.value && to.value && from.value > to.value ? 'The start date must be on or before the end date.' : '');
    const compareFrom = form.elements.namedItem('compare_start');
    const compareTo = form.elements.namedItem('compare_end');
    compareTo.min = compareFrom.value || '2000-01-01';
    compareFrom.setCustomValidity(custom && compareFrom.value > compareTo.value ? 'Check the comparison dates.' : '');
  });
  document.addEventListener('click', (event) => { if (!picker.contains(event.target)) picker.open = false; });
  picker.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { picker.open = false; picker.querySelector('summary').focus(); }
  });
}
