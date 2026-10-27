const css = `
.dc-usage {position:absolute;pointer-events:auto;width:max-content;font:12px var(--dc-font-ui,system-ui);color:var(--dc-foreground);max-width:min(320px,calc(100% - 32px))}
.dc-usage [hidden] {display:none!important}
.dc-usage button {font:inherit;color:inherit;cursor:pointer;border:0;background:transparent;border-radius:8px;padding:9px;text-align:left}
.dc-usage button:hover {background:var(--dc-surface-hover)}
.dc-usage__summary {display:flex;align-items:center;min-width:182px;max-width:100%;background:var(--dc-surface-raised);border:1px solid var(--dc-border);border-radius:12px;box-shadow:0 3px 14px #0000000c}
.dc-usage__summary[data-subscription] {min-width:0;border-radius:10px}
.dc-usage__summary[data-subscription]>.dc-usage__body {display:flex;align-items:center;min-height:38px;padding:9px 9px 9px 13px}
.dc-usage__body {flex:1;min-width:0;display:grid;gap:4px}.dc-usage strong{font-weight:600}.dc-usage small{color:var(--dc-muted);font-size:11px}
.dc-usage__body small {overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dc-usage [data-usage-drag] {cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
.dc-usage[data-dragging] [data-usage-drag] {cursor:grabbing}
.dc-usage__details,.dc-usage__menu {position:absolute;box-sizing:border-box;overflow:auto;background:var(--dc-surface-raised);border:1px solid var(--dc-border);box-shadow:0 6px 24px #00000010;border-radius:12px;padding:14px;width:260px;max-width:calc(var(--dc-usage-boundary-width) - 32px)}
.dc-usage__line {display:flex;justify-content:space-between;gap:12px;margin:10px 0}.dc-usage__menu {width:180px;padding:5px}.dc-usage__menu button {display:block;width:100%}
.dc-usage__chart {height:28px;display:flex;gap:3px;align-items:end;margin-top:14px}.dc-usage__chart i{flex:1;background:var(--dc-accent);opacity:.6;min-height:1px;border-radius:2px}
.dc-usage__error {color:var(--dc-danger);overflow-wrap:anywhere}.dc-usage__handle{display:flex;align-items:center;justify-content:center;width:var(--dc-usage-handle-width,18px);height:var(--dc-usage-handle-height,28px);padding:0!important;background:var(--dc-surface-raised)!important;border:1px solid var(--dc-border)!important;border-radius:var(--dc-radius-control) 0 0 var(--dc-radius-control)!important}
.dc-usage[data-dock='left'] .dc-usage__handle {border-radius:0 var(--dc-radius-control) var(--dc-radius-control) 0!important}
.dc-usage[data-dragging] .dc-usage__handle {border-radius:var(--dc-radius-control)!important}
`;
const positionKey = 'achbit:usage-widget:position';
export default { apply(context) {
  context.addStyle(css);
  context.register('usage.widget', (container, initial, scope) => {
    let input = initial, request, requestKey = '', queryKey = '', data = null, error = '', loading = false, menu = false, timer;
    let position = null, drag = null, suppressClick = false, dock = 'right';
    try {
      const saved = JSON.parse(window.localStorage.getItem(positionKey) ?? 'null');
      if (saved && (saved.x === null || Number.isFinite(saved.x)) && Number.isFinite(saved.centerY)
        && (saved.dock === 'left' || saved.dock === 'right')) {
        position = { x: saved.x, centerY: saved.centerY }; dock = saved.dock;
      }
    } catch (reason) { console.error('Cannot restore usage widget position', reason); }
    const savePosition = () => {
      try { window.localStorage.setItem(positionKey, JSON.stringify({ ...position, dock })); }
      catch (reason) { console.error('Cannot save usage widget position', reason); }
    };
    const root = document.createElement('section'); root.className = 'dc-usage'; container.append(root);
    const text = key => input.labels[key];
    const node = (tag, content, cls) => { const el = document.createElement(tag); if (content != null) el.textContent = content; if(cls) el.className = cls; return el; };
    const button = (label, action, cls) => { const el = node('button', label, cls); el.type='button'; el.onclick=action; return el; };
    const money = value => new Intl.NumberFormat(input.locale,{style:'currency',currency:input.costDisplay.currency,maximumFractionDigits:4}).format(value * input.costDisplay.usdRate);
    const remaining = window => `${Math.max(0, Math.min(100, 100-window.usedPercent)).toFixed(0)}%`;
    const line = (parent,label,value) => { const row=node('div',null,'dc-usage__line'); row.append(node('span',label),node('strong',value));parent.append(row); };
    const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
    // Keep the controls mounted while usage changes so a response cannot swallow a pointer click.
    const summary = node('div', null, 'dc-usage__summary');
    const body = button('', () => scope.actions.setExpanded(!input.expanded), 'dc-usage__body');
    body.dataset.usageDrag = '';
    const caption = node('small'), amountLabel = node('strong'); body.append(caption, amountLabel);
    const collapse = button('›', () => scope.actions.setUsageVisibility('collapsed'));
    summary.append(body, collapse);
    const handle = button('‹', () => scope.actions.setUsageVisibility('summary'), 'dc-usage__handle');
    handle.dataset.usageDrag = '';
    const detail = node('div', null, 'dc-usage__details'); detail.dataset.nativeOverlay = '';
    const menuBox = node('div', null, 'dc-usage__menu'); menuBox.setAttribute('role', 'menu'); menuBox.dataset.nativeOverlay = '';
    const settings = button('', () => { menu = false; render(); scope.actions.openUsageSettings(); });
    const hide = button('', () => { menu = false; scope.actions.setUsageVisibility('hidden'); });
    menuBox.append(settings, hide);
    const attach = (element, visible) => {
      if (visible && !root.contains(element)) root.append(element);
      else if (!visible && root.contains(element)) element.remove();
    };
    const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
    let detailState = [];
    function place() {
      if (root.hidden || !container.clientWidth || !container.clientHeight) return;
      const width = container.clientWidth, height = container.clientHeight;
      root.style.setProperty('--dc-usage-boundary-width', `${width}px`);
      const box = root.getBoundingClientRect();
      // The compact handle docks at an edge; the summary opens into the panel.
      // Layout changes constrain rendering, not the user's remembered position.
      // Until moved, the summary follows the current right edge.
      position ??= { x: null, centerY: height - 16 - box.height / 2 };
      const docked = input.visibility === 'collapsed' && !drag?.started;
      const x = docked ? dock === 'left' ? 0 : width - box.width
        : clamp(position.x ?? width - box.width - 16, 8, width - box.width - 8);
      const y = clamp(position.centerY - box.height / 2, 8, height - box.height - 8);
      root.dataset.dock = dock;
      const handle = root.querySelectorAll('.dc-usage__handle')[0];
      if (handle) handle.textContent = dock === 'left' ? '›' : '‹';
      root.style.left = `${x}px`; root.style.top = `${y}px`;
      for (const panel of root.querySelectorAll('.dc-usage__details,.dc-usage__menu')) {
        panel.style.maxHeight = `${Math.max(0, height - 16)}px`;
        const size = panel.getBoundingClientRect();
        const panelX = clamp(x + box.width - size.width, 8, width - size.width - 8);
        const panelY = y >= size.height + 16 ? y - size.height - 8
          : clamp(y + box.height + 8, 8, height - size.height - 8);
        panel.style.left = `${panelX - x}px`; panel.style.top = `${panelY - y}px`;
      }
    }
    root.addEventListener('pointerdown', event => {
      suppressClick = false;
      if (event.button !== 0 || !event.isPrimary || !event.target.closest('[data-usage-drag]')) return;
      const box = root.getBoundingClientRect(), bounds = container.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
        left: box.left - bounds.left, centerY: box.top - bounds.top + box.height / 2, started: false };
    });
    const move = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.started && Math.hypot(dx, dy) < 4) return;
      if (!drag.started) { drag.started = true; root.setPointerCapture(event.pointerId); root.dataset.dragging = ''; }
      event.preventDefault(); suppressClick = true;
      const box = root.getBoundingClientRect();
      position = { x: clamp(drag.left + dx, 8, container.clientWidth - box.width - 8),
        centerY: clamp(drag.centerY + dy, box.height / 2 + 8, container.clientHeight - box.height / 2 - 8) };
      place();
    };
    const endDrag = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.started;
      drag = null; delete root.dataset.dragging;
      if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
      if (moved && input.visibility === 'collapsed') {
        const box = root.getBoundingClientRect();
        dock = position.x + box.width / 2 < container.clientWidth / 2 ? 'left' : 'right';
        position.x = dock === 'left' ? 0 : container.clientWidth - box.width;
        place();
      }
      if (moved) savePosition();
    };
    const cancelDrag = () => { if (drag) endDrag({ pointerId: drag.id }); };
    root.addEventListener('lostpointercapture', endDrag);
    root.addEventListener('click', event => {
      if (suppressClick && event.detail > 0) { event.preventDefault(); event.stopPropagation(); }
    }, true);
    root.addEventListener('keydown', event => {
      if (!event.target.closest('[data-usage-drag]') || event.altKey || event.ctrlKey || event.metaKey) return;
      const offset = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }[event.key];
      if (!offset || !position) return;
      event.preventDefault(); const step = event.shiftKey ? 40 : 10;
      if (input.visibility === 'collapsed' && offset[0]) dock = offset[0] < 0 ? 'left' : 'right';
      const box = root.getBoundingClientRect(), bounds = container.getBoundingClientRect();
      position = { x: clamp(box.left - bounds.left + offset[0] * step, 8, container.clientWidth - box.width - 8),
        centerY: clamp(box.top - bounds.top + box.height / 2 + offset[1] * step, box.height / 2 + 8, container.clientHeight - box.height / 2 - 8) };
      if (input.visibility === 'collapsed') position.x = dock === 'left' ? 0 : container.clientWidth - box.width;
      place();
      savePosition();
    });
    const sizeObserver = new ResizeObserver(place);
    sizeObserver.observe(container); sizeObserver.observe(root);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', cancelDrag);
    function render() {
      root.hidden = input.visibility === 'hidden' || !input.connection;
      if (root.hidden) { cancelDrag(); return; }
      root.oncontextmenu = event => {event.preventDefault();menu=true;render();};
      setText(settings, text('settings')); setText(hide, text('hide'));
      attach(menuBox, menu);
      const collapsed = input.visibility === 'collapsed';
      attach(handle, collapsed); attach(summary, !collapsed);
      handle.setAttribute('aria-label', text('show'));
      attach(detail, !collapsed && input.expanded && !menu);
      if (collapsed) { place(); return; }
      const plan = input.connection.billingMode === 'subscription';
      const quota = plan && input.connection.credentialKind === 'oauth';
      const windows = quota && data?.windows ? [...data.windows].sort((a,b)=>b.windowDurationSeconds-a.windowDurationSeconds) : [];
      const totals = !quota && data?.totals;
      const amount = error ? text('unavailable') : loading && !data ? '…' : quota ? windows.length ? remaining(windows[0]) : '—' : plan ? totals?.reportedCalls ? `${(totals.inputTokens + totals.outputTokens).toLocaleString()} tokens` : totals?.calls === 0 ? text('noCalls') : text('unavailable') : totals?.estimatedCost != null ? money(totals.estimatedCost) : totals?.calls === 0 ? text('noCalls') : text('unpriced');
      const nextDetailState = [data, error, loading && !data, plan, input.locale, input.costDisplay.currency, input.costDisplay.usdRate];
      detail.setAttribute('aria-busy', String(loading));
      if (nextDetailState.some((value, index) => value !== detailState[index])) {
        detailState = nextDetailState;
        const scrollTop = detail.scrollTop;
        detail.replaceChildren();
        detail.append(node('strong',quota ? text('remaining') : text('today')));
        if(error) detail.append(node('p',error,'dc-usage__error'));
        else if(loading && !data) detail.append(node('small','…'));
        else if(quota) { for(const window of windows) { line(detail,window.label,remaining(window)); if(window.resetsAt) detail.append(node('small',text('resets')+new Date(window.resetsAt).toLocaleString(input.locale))); } }
        else if(totals) { if (!plan) line(detail,text('estimate'),amount);line(detail,text('tokens'),`${totals.inputTokens.toLocaleString()} / ${totals.outputTokens.toLocaleString()}`);line(detail,text('cached'),totals.cacheReadTokens.toLocaleString());line(detail,text('calls'),String(totals.calls));
          if(!plan && totals.pricedCalls < totals.calls) detail.append(node('small',text('priced')+`${totals.pricedCalls}/${totals.calls}`));
          if(data.coverageFrom > data.query.from) detail.append(node('small',text('coverage')+new Date(data.coverageFrom).toLocaleString(input.locale)));
          const chart=node('div',null,'dc-usage__chart'), max=Math.max(1,...data.buckets.map(bucket=>bucket.inputTokens+bucket.outputTokens));chart.setAttribute('aria-label',text('hourly'));
          for(const bucket of data.buckets) { const bar=node('i');bar.style.height=`${(bucket.inputTokens+bucket.outputTokens)/max*100}%`;bar.title=`${bucket.label}: ${bucket.inputTokens+bucket.outputTokens}`;chart.append(bar); }detail.append(chart);
        }
        detail.scrollTop = scrollTop;
      }
      body.setAttribute('aria-expanded',String(input.expanded));
      caption.hidden = plan;
      if (plan) {
        summary.dataset.subscription = '';
        setText(amountLabel, input.connection.adapterId === 'openai-codex' ? 'Codex' : input.connection.name);
      } else {
        delete summary.dataset.subscription;
        setText(caption, (input.modelId ?? input.connection.name)+' · '+text('todayEstimate'));
        setText(amountLabel, amount);
      }
      collapse.setAttribute('aria-label',text('collapse'));
      place();
    }
    async function refresh(force=false) {
      const day=new Date();day.setHours(0,0,0,0);
      const query=JSON.stringify([input.connection?.id,input.connection?.billingMode,input.modelId,day.getTime()]);
      const key=JSON.stringify([query,input.revision]);
      if(input.visibility==='hidden'||!input.connection) {clearTimeout(timer);request?.abort();request=null;requestKey='';render();return;}
      // Only a different query invalidates the displayed successful snapshot.
      if(query!==queryKey) {request?.abort();request=null;queryKey=query;data=null;error='';}
      // Let an in-flight read finish; a newer revision is read once afterward, without starvation.
      if(request) {render();return;}
      if(!force&&key===requestKey) {render();return;}
      clearTimeout(timer);requestKey=key;request=new AbortController();const current=request;
      loading=true;render();
      try { const value=input.connection.billingMode==='subscription' && input.connection.credentialKind==='oauth' ? await scope.quota.read(current.signal) : await scope.usage.query({from:day.getTime(),to:Math.max(day.getTime()+1,Date.now()),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,granularity:'hour',connectionId:input.connection.id,modelId:input.modelId},current.signal);
        if(current.signal.aborted||scope.signal.aborted)return;data=value;error='';
      } catch(reason) {if(current.signal.aborted||scope.signal.aborted)return;data=null;error=reason instanceof Error?reason.message:String(reason);}
      if(current.signal.aborted||scope.signal.aborted)return;
      request=null;loading=false;render();const tomorrow=new Date(day);tomorrow.setDate(tomorrow.getDate()+1);timer=setTimeout(()=>void refresh(true),Math.max(1,tomorrow.getTime()-Date.now()));
      if(key!==JSON.stringify([queryKey,input.revision])) void refresh();
    }
    const dismiss = event => {
      if (root.contains(event.target) || (!menu && !input.expanded)) return;
      menu = false;
      if (input.expanded) scope.actions.setExpanded(false);
      render();
    };
    const escape = event => { if(event.key==='Escape'&&(menu||input.expanded)) {menu=false;scope.actions.setExpanded(false);render();} };
    document.addEventListener('pointerdown',dismiss,true);document.addEventListener('keydown',escape);
    void refresh();
    return {
      update(next) {
        if (next.visibility !== input.visibility) { menu = false; cancelDrag(); }
        const opened = next.expanded && !input.expanded;
        input = next;
        // Provider responses advance the revision; opening the details also reads current usage.
        void refresh(opened);
      },
      dispose() {
        request?.abort(); clearTimeout(timer); cancelDrag(); sizeObserver.disconnect();
        document.removeEventListener('pointerdown',dismiss,true); document.removeEventListener('keydown',escape);
        document.removeEventListener('pointermove',move); document.removeEventListener('pointerup',endDrag);
        document.removeEventListener('pointercancel',endDrag); window.removeEventListener('blur',cancelDrag);
        root.remove();
      },
    };
  });
}};
