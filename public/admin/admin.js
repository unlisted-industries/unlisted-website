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
  const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
  if (/^[0-9a-f]{64}$/.test(token)) {
    activation.elements.namedItem('token').value = token;
    activation.querySelector('button').disabled = false;
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    activation.querySelector('[data-activation-help]').hidden = false;
  }
}
