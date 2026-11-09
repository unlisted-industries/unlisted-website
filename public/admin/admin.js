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
