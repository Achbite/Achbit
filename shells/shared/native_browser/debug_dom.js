(() => {
  if (window.__ACHBIT_DEBUG_DOM__) return;
  const channel = 'achbit.debug.frame.v1';
  const waiting = new Map();
  let sequence = 0;
  const selectorFor = element => {
    const parts = [];
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const siblings = [...(node.parentElement?.children ?? [])].filter(other => other.localName === node.localName);
      parts.unshift(node.localName + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''));
    }
    return parts.join(' > ');
  };
  const visible = element => {
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
  };
  const frames = () => [...document.querySelectorAll('iframe,frame')];
  const inspect = () => {
    const text = document.body?.innerText ?? '';
    const elements = [...document.querySelectorAll('a,button,input,textarea,select,summary,[role],[tabindex],[contenteditable="true"]')].filter(visible);
    return {
    url: location.href, title: document.title, readyState: document.readyState,
    hostStatus: document.querySelector('[data-host-status]')?.getAttribute('data-host-status') ?? null,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    text: text.slice(0, 64000), textLimit: 64000,
    coverage: { text: text.length > 64000 ? 'truncated' : 'complete', elements: elements.length > 512 ? 'truncated' : 'complete', totalElements: elements.length },
    elements: elements.slice(0, 512).map(element => {
        const r = element.getBoundingClientRect();
        const disabled = !!element.closest(':disabled,[aria-disabled="true"],[inert]');
        const editable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable;
        const actions = ['focus', 'scroll', 'key'];
        if (typeof element.click === 'function') actions.push('click');
        if (editable) actions.push('type');
        if (element instanceof HTMLSelectElement) actions.push('select');
        return { selector: selectorFor(element), role: element.getAttribute('role') ?? element.localName,
          text: (element.getAttribute('aria-label') ?? element.innerText ?? '').slice(0, 1000),
          value: element.matches('input[type="password"]') ? undefined : element.value,
          checked: element.checked, disabled, readOnly: !!element.readOnly,
          actions: actions.map(name => ({ name, availability: disabled || (name === 'type' && element.readOnly) ? 'unavailable' : 'available',
            reason: disabled ? 'debug_element_disabled' : name === 'type' && element.readOnly ? 'debug_input_read_only' : null })),
          options: element instanceof HTMLSelectElement ? [...element.options].map(option => ({ value: option.value, text: option.text, selected: option.selected })) : undefined,
          bounds: { x: r.x, y: r.y, width: r.width, height: r.height } };
      }), elementLimit: 512,
    frames: frames().map((frame, index) => ({ index, title: frame.title, src: frame.src, selector: selectorFor(frame), visible: visible(frame) })),
    components: window.__ACHBIT_DEBUG_UI__?.list() ?? [],
    };
  };
  function requestFrame(frame, request) {
    if (!frame?.contentWindow) return Promise.reject(Error('debug_frame_not_found'));
    const id = `${Date.now()}-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiting.delete(id); reject(Error('debug_frame_response_timeout')); }, 18000);
      waiting.set(id, { source: frame.contentWindow, resolve, reject, timeout });
      frame.contentWindow.postMessage({ channel, id, request }, '*');
    });
  }
  function renderBoundary() {
    return new Promise(resolve => {
      let finished = false;
      const timeout = setTimeout(() => { if (!finished) { finished = true; resolve({ rendered: false, reason: 'frame-not-observed' }); } }, 1000);
      requestAnimationFrame(() => requestAnimationFrame(() => { if (!finished) { finished = true; clearTimeout(timeout); resolve({ rendered: true, boundary: 'two-animation-frames', paintDurationMs: null }); } }));
    });
  }
  function waitFor(spec) {
    if (!spec) return Promise.resolve(null);
    if (typeof spec.selector !== 'string' && typeof spec.componentId !== 'string') throw Error('debug_wait_target_required');
    if (spec.path !== undefined && (!Array.isArray(spec.path) || spec.path.some(key => typeof key !== 'string'))) throw Error('debug_wait_path_invalid');
    const timeoutMs = Math.min(Math.max(Number(spec.timeoutMs ?? 5000), 1), 15000);
    const matches = () => {
      if (typeof spec.componentId === 'string') {
        const component = window.__ACHBIT_DEBUG_UI__?.list().find(item => item.id === spec.componentId);
        if (spec.absent) return !component;
        if (!component) return false;
        if (!('equals' in spec)) return true;
        const value = (spec.path ?? []).reduce((current, key) => current?.[key], component.input);
        return JSON.stringify(value) === JSON.stringify(spec.equals);
      }
      const element = document.querySelector(spec.selector);
      if (spec.absent) return !element;
      return !!element && (!spec.visible || visible(element)) && (spec.text === undefined || element.textContent.includes(spec.text)) && (spec.value === undefined || element.value === spec.value);
    };
    if (matches()) return Promise.resolve({ matched: true });
    return new Promise((resolve, reject) => {
      let frame;
      const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(Error('debug_wait_condition_timeout')); }, timeoutMs);
      // Component state and input.value need not mutate DOM attributes.
      const check = () => {
        if (matches()) { clearTimeout(timer); resolve({ matched: true }); }
        else frame = requestAnimationFrame(check);
      };
      frame = requestAnimationFrame(check);
    });
  }
  async function dispatch(request) {
    const path = request.framePath ?? [];
    if (!Array.isArray(path) || path.some(item => !Number.isSafeInteger(item) || item < 0) || path.length > 16) throw Error('debug_invalid_frame_path');
    if (path.length) return requestFrame(frames()[path[0]], { ...request, framePath: path.slice(1) });
    if (request.name === 'inspect') return inspect();
    if (request.name === 'components') return window.__ACHBIT_DEBUG_UI__?.list() ?? [];
    if (request.name === 'metrics') return window.__ACHBIT_DEBUG_UI__?.measurements() ?? { records: [], coverage: 'not-applicable' };
    if (request.name === 'surfaces') {
      const rows = [{ framePath: [], state: inspect() }];
      if ((request.depth ?? 0) >= 8) return rows;
      await Promise.all(frames().map(async (frame, index) => {
        try {
          const child = await requestFrame(frame, { name: 'surfaces', depth: (request.depth ?? 0) + 1 });
          for (const row of child) rows.push({ ...row, framePath: [index, ...row.framePath] });
        } catch (error) { rows.push({ framePath: [index], state: { status: 'unavailable', error: String(error), src: frame.src } }); }
      }));
      return rows;
    }
    const before = inspect();
    const startedAt = performance.now();
    const args = request.args ?? {};
    const element = args.selector ? document.querySelector(args.selector) : null;
    if (args.selector && !element) throw Error('debug_element_not_found');
    if (element && element.closest(':disabled,[aria-disabled="true"],[inert]')) throw Error('debug_element_disabled');
    let result;
    switch (request.name) {
      case 'plugin.action':
        if (!window.__ACHBIT_DEBUG_UI__) throw Error('debug_ui_components_unavailable');
        result = await window.__ACHBIT_DEBUG_UI__.call(args.componentId, args.action, args.arguments ?? []); break;
      case 'click': {
        if (!element || typeof element.click !== 'function') throw Error('debug_click_selector_required');
        element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        const r = element.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === element || element.contains(hit))) throw Error('debug_element_covered');
        const pointer = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        const accepted = element.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
        if (accepted) { element.dispatchEvent(new MouseEvent('mousedown', { ...pointer, buttons: 1 })); element.focus(); }
        element.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
        if (accepted) element.dispatchEvent(new MouseEvent('mouseup', { ...pointer, buttons: 0 }));
        element.click(); result = { dispatched: true }; break;
      }
      case 'type': {
        if (typeof args.text !== 'string') throw Error('debug_text_required');
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element?.isContentEditable)) throw Error('debug_text_input_required');
        if (element.readOnly) throw Error('debug_input_read_only');
        element.focus();
        if (element.isContentEditable) element.textContent = args.text;
        else Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, args.text);
        element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); result = { dispatched: true }; break;
      }
      case 'select':
        if (!(element instanceof HTMLSelectElement) || typeof args.value !== 'string') throw Error('debug_select_arguments_invalid');
        if (![...element.options].some(option => option.value === args.value)) throw Error('debug_select_option_missing');
        element.value = args.value; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); result = { selected: args.value }; break;
      case 'key': {
        if (typeof args.key !== 'string') throw Error('debug_key_required');
        const target = element ?? document.activeElement ?? document.body;
        const options = { key: args.key, code: args.code ?? args.key, ctrlKey: !!args.ctrl, metaKey: !!args.meta, altKey: !!args.alt, shiftKey: !!args.shift, bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent('keydown', options)); target.dispatchEvent(new KeyboardEvent('keyup', options)); result = { dispatched: true, defaultNativeEditing: false }; break;
      }
      case 'focus':
        if (!element || typeof element.focus !== 'function') throw Error('debug_focus_selector_required');
        element.focus(); result = { focused: document.activeElement === element }; break;
      case 'scroll': {
        const target = element ?? document.scrollingElement;
        if (!target) throw Error('debug_scroll_target_unavailable');
        target.scrollBy({ left: Number(args.x ?? 0), top: Number(args.y ?? 0), behavior: 'instant' }); result = { left: target.scrollLeft, top: target.scrollTop }; break;
      }
      case 'wait': result = { requested: true }; break;
      default: throw Error('debug_action_not_supported');
    }
    const handlerDurationMs = performance.now() - startedAt;
    let condition;
    try { condition = await waitFor(args.waitFor); }
    catch (error) { condition = { matched: false, error: String(error) }; }
    const rendered = await renderBoundary();
    const after = inspect();
    const complete = condition?.matched !== false && rendered.rendered && after.coverage.text === 'complete' && after.coverage.elements === 'complete';
    return { before, after, result, condition, completion: complete ? 'ui-observed' : 'observation-incomplete',
      businessCompletion: request.name === 'plugin.action' ? result.businessCompletion : 'not-asserted',
      timing: { clockDomain: 'webview.performance', handlerDurationMs, observedDurationMs: performance.now() - startedAt, ...rendered } };
  }
  window.addEventListener('message', async event => {
    const message = event.data;
    if (!message || message.channel !== channel || typeof message.id !== 'string') return;
    if (message.reply === true) {
      const entry = waiting.get(message.id);
      if (!entry || entry.source !== event.source) return;
      waiting.delete(message.id); clearTimeout(entry.timeout);
      if (message.error) entry.reject(Error(message.error)); else entry.resolve(message.value);
    } else if (window.parent !== window && event.source === window.parent && message.request) {
      try { event.source.postMessage({ channel, id: message.id, reply: true, value: await dispatch(message.request) }, '*'); }
      catch (error) { event.source.postMessage({ channel, id: message.id, reply: true, error: String(error) }, '*'); }
    }
  });
  Object.defineProperty(window, '__ACHBIT_DEBUG_DOM__', { value: { dispatch }, configurable: false });
})();
