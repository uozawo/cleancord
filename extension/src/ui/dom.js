// Modals, toasts and a tiny declarative form builder used by every dialog.

import { h, $, fill } from '../util.js';

let modalStack = [];

export function openModal({ title, body, actions = [], width = 560, onClose, dismissable = true, className = '' }) {
  const overlay = h('div', { class: 'modal-overlay' });
  const footer = h('div', { class: 'modal-foot' });
  const box = h('div', { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true', tabindex: '-1', style: { width: `min(${width}px, calc(100vw - 32px))` } },
    h('div', { class: 'modal-head' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', title: 'Close', onclick: () => close() }, '✕')),
    h('div', { class: 'modal-body' }, body),
    footer);
  overlay.append(box);
  let closed = false;
  const api = {
    el: box,
    body: $('.modal-body', box),
    close,
    setBusy(b) { box.classList.toggle('busy', b); for (const btn of footer.querySelectorAll('button')) btn.disabled = b; },
    setActions,
  };
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    modalStack = modalStack.filter((m) => m !== api);
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  }
  function onKey(e) {
    if (e.key === 'Escape' && dismissable && modalStack[modalStack.length - 1] === api) close();
  }
  function setActions(list) {
    fill(footer, ...list.map((a) => {
      const btn = h('button', { class: `btn ${a.kind || ''}`, disabled: a.disabled }, a.label);
      btn.addEventListener('click', async () => {
        if (!a.onClick) return close();
        try {
          api.setBusy(true);
          const keep = await a.onClick(api);
          if (keep === false) api.setBusy(false); else close();
        } catch (e) {
          api.setBusy(false);
          toast(e.message || String(e), 'error');
        }
      });
      return btn;
    }));
    footer.hidden = !list.length;
  }
  setActions(actions);
  // The second click of a double-click on the button that opened the dialog lands on the overlay:
  // don't treat it as "click outside" (it closed confirmations before they could be read).
  const openedAt = performance.now();
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && dismissable && performance.now() - openedAt > 500) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  modalStack.push(api);
  // Move focus into the dialog, so Enter/Space can't re-trigger the button behind the overlay.
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  setTimeout(() => {
    if (closed) return;
    const f = box.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select');
    (f || box).focus();
  }, 30);
  return api;
}

export function confirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Continue', danger = false, cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title, width: 460,
      body: typeof message === 'string' ? h('p', { class: 'pre-line' }, message) : message,
      actions: [
        { label: cancelLabel, kind: 'ghost' },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', password = false, hint = '', confirmLabel = 'OK' }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { class: 'input', type: password ? 'password' : 'text', value, placeholder, autocomplete: 'off', spellcheck: 'false' });
    const m = openModal({
      title, width: 480,
      body: h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null)),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: confirmLabel, kind: 'primary', onClick: () => { result = input.value; } },
      ],
      onClose: () => resolve(result),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { result = input.value; m.close(); } });
  });
}

let toastHost = null;
export function toast(message, kind = 'info', ms = 4000) {
  if (!toastHost) { toastHost = h('div', { class: 'toasts' }); document.body.append(toastHost); }
  const t = h('div', { class: `toast ${kind}` }, message);
  toastHost.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

/*
 buildForm(fields, { onChange })
 field: { key, type: text|password|textarea|number|date|select|radio|checks|toggle|section|note|row|custom,
          label, hint, value, options: [[value, label]], placeholder, min, max, step, when: (values) => bool, el (custom) }
*/
export function buildForm(fields, { onChange } = {}) {
  const inputs = new Map();
  const wrappers = [];
  const root = h('div', { class: 'form' });

  const values = () => {
    const v = {};
    for (const [key, get] of inputs) v[key] = get();
    return v;
  };
  const refresh = () => {
    const v = values();
    for (const { el, when } of wrappers) el.hidden = when ? !when(v) : false;
  };
  const changed = () => { refresh(); if (onChange) onChange(values()); };

  const make = (f) => {
    let el;
    switch (f.type) {
      case 'section':
        el = h('div', { class: 'form-section' }, f.label, f.hint ? h('span', { class: 'hint' }, f.hint) : null);
        break;
      case 'note':
        el = h('div', { class: `form-note ${f.kind || ''}` }, f.label);
        break;
      case 'custom':
        el = f.el;
        if (f.key && f.get) inputs.set(f.key, f.get);
        break;
      case 'row':
        el = h('div', { class: 'form-row' }, f.items.filter(Boolean).map(make));
        break;
      case 'toggle': {
        const input = h('input', { type: 'checkbox', checked: !!f.value, onchange: changed });
        inputs.set(f.key, () => input.checked);
        el = h('label', { class: 'toggle' }, input, h('span', null, f.label), f.hint ? h('span', { class: 'hint' }, f.hint) : null);
        break;
      }
      case 'radio': {
        const name = `r-${f.key}-${Math.random().toString(36).slice(2, 7)}`;
        const opts = f.options.map(([val, label, hint]) => {
          const input = h('input', { type: 'radio', name, value: val, checked: f.value === val, onchange: changed });
          return { input, el: h('label', { class: 'radio' }, input, h('span', null, label, hint ? h('span', { class: 'hint' }, hint) : null)) };
        });
        inputs.set(f.key, () => (opts.find((o) => o.input.checked) || {}).input?.value ?? null);
        el = h('div', { class: 'field' }, f.label ? h('span', { class: 'field-label' }, f.label) : null, h('div', { class: f.inline ? 'radios inline' : 'radios' }, opts.map((o) => o.el)), f.hint ? h('span', { class: 'hint' }, f.hint) : null);
        break;
      }
      case 'checks': {
        const set = new Set(f.value || []);
        const opts = f.options.map(([val, label]) => {
          const input = h('input', { type: 'checkbox', value: val, checked: set.has(val), onchange: changed });
          return { input, el: h('label', { class: 'check' }, input, h('span', null, label)) };
        });
        inputs.set(f.key, () => opts.filter((o) => o.input.checked).map((o) => o.input.value));
        el = h('div', { class: 'field' }, f.label ? h('span', { class: 'field-label' }, f.label) : null, h('div', { class: 'checks' }, opts.map((o) => o.el)), f.hint ? h('span', { class: 'hint' }, f.hint) : null);
        break;
      }
      case 'select': {
        const input = h('select', { class: 'input', onchange: changed }, f.options.map(([val, label]) => h('option', { value: val, selected: String(f.value) === String(val) }, label)));
        inputs.set(f.key, () => input.value);
        el = h('label', { class: 'field' }, f.label ? h('span', { class: 'field-label' }, f.label) : null, input, f.hint ? h('span', { class: 'hint' }, f.hint) : null);
        break;
      }
      case 'textarea': {
        const input = h('textarea', { class: 'input', rows: f.rows || 3, placeholder: f.placeholder || '', oninput: changed, spellcheck: 'false' });
        input.value = f.value ?? '';
        inputs.set(f.key, () => input.value);
        el = h('label', { class: 'field' }, f.label ? h('span', { class: 'field-label' }, f.label) : null, input, f.hint ? h('span', { class: 'hint' }, f.hint) : null);
        break;
      }
      default: {
        const input = h('input', {
          class: 'input', type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '',
          min: f.min, max: f.max, step: f.step, oninput: changed, autocomplete: 'off', spellcheck: 'false',
        });
        inputs.set(f.key, () => (f.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value.trim()));
        el = h('label', { class: 'field' }, f.label ? h('span', { class: 'field-label' }, f.label) : null, input, f.hint ? h('span', { class: 'hint' }, f.hint) : null);
      }
    }
    if (f.when) wrappers.push({ el, when: f.when });
    return el;
  };

  for (const f of fields) if (f) root.append(make(f));
  refresh();
  return { el: root, values, refresh };
}

let closeMenu = null;
export function menu(anchor, items) {
  if (closeMenu) closeMenu();
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const r = anchor.getBoundingClientRect();
  const done = () => {
    el.remove();
    document.removeEventListener('mousedown', off, true);
    document.removeEventListener('keydown', onKey, true);
    if (closeMenu === done) closeMenu = null;
  };
  closeMenu = done;
  const el = h('div', { class: 'menu', style: { top: '0px', left: '0px', visibility: 'hidden' } },
    items.filter(Boolean).map((it) => it === '-' ? h('div', { class: 'menu-sep' }) : h('button', {
      class: `menu-item${it.danger ? ' danger' : ''}`, disabled: it.disabled,
      onclick: () => { done(); it.onClick(); },
    }, it.label)));
  document.body.append(el);
  // Keep the whole menu on screen: align it to the anchor's right edge near the right side of the
  // window, and open it upwards when there is no room below.
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  const left = r.left + w > innerWidth - 8 ? Math.max(8, Math.min(r.right, innerWidth - 8) - w) : r.left;
  const below = r.bottom + 4;
  const top = below + ht <= innerHeight - 8 ? below : r.top - 4 - ht >= 8 ? r.top - 4 - ht : Math.max(8, innerHeight - 8 - ht);
  Object.assign(el.style, { left: `${left}px`, top: `${top}px`, visibility: '' });
  const off = (e) => { if (!el.contains(e.target)) done(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
  setTimeout(() => { if (el.isConnected) { document.addEventListener('mousedown', off, true); document.addEventListener('keydown', onKey, true); } }, 0);
  return el;
}
