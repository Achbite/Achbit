/** Optional example: the Host owns accounting; this view only queries and renders it. */
export default {
  apply(context) {
    context.register('settings.usage.panel', (container, initial, scope) => {
      const heading = document.createElement('h3');
      const select = document.createElement('select');
      const output = document.createElement('p'); output.setAttribute('role', 'status');
      container.append(heading, select, output);
      let input = initial, pending;
      const render = report => {
        const t = report.totals;
        const zh = input.locale === 'zh-CN';
        const number = value => value.toLocaleString(input.locale);
        const usage = t.reportedCalls
          ? (zh ? '输入 ' + number(t.inputTokens) + ' / 输出 ' + number(t.outputTokens) : number(t.inputTokens) + ' input / ' + number(t.outputTokens) + ' output')
          : (zh ? '用量不可用' : 'Usage unavailable');
        const price = t.estimatedCost === null ? (zh ? '价格不可用' : 'Price unavailable')
          : '$' + t.estimatedCost.toFixed(4) + (t.pricedCalls < t.calls ? (zh ? '（部分）' : ' (partial)') : '');
        output.textContent = [number(t.calls) + (zh ? ' 次调用' : ' calls'), usage, price].join(' · ');
      };
      const update = next => {
        pending?.abort(); input = next;
        if (input.kind !== 'settings.usage') throw new Error('Expected usage settings input');
        select.replaceChildren();
        const zh = input.locale === 'zh-CN';
        heading.textContent = zh ? '会话' : 'Session';
        select.setAttribute('aria-label', heading.textContent);
        const all = new Option(zh ? '所有会话' : 'All sessions', ''); select.append(all);
        for (const session of input.report.sessions) select.append(new Option(session.sessionId, session.sessionId));
        render(input.report);
      };
      select.addEventListener('change', async () => {
        pending?.abort(); const controller = pending = new AbortController();
        try {
          if (!scope.usage) throw new Error('usage.read is required');
          const report = await scope.usage.query({ ...input.query, ...(select.value ? { sessionId: select.value } : {}) }, controller.signal);
          if (!controller.signal.aborted && !scope.signal.aborted) render(report);
        } catch (error) { if (!controller.signal.aborted && !scope.signal.aborted) output.textContent = String(error); }
      });
      update(initial);
      return { update, dispose() { pending?.abort(); container.replaceChildren(); } };
    });
  },
};
