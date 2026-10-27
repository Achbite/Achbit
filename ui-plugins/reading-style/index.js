// A standalone display module: no Achbit React dependency or Agent/tool imports.
export default {
  apply(ctx) {
    ctx.addStyle(`
      .document-preview__markdown { max-width: 76ch; margin-inline: auto; line-height: 1.8; }
      .reading-style-preview { padding: 16px; background: #f6f5f1; }
      .reading-style-preview iframe { display: block; width: 100%; height: 62dvh; border: 0; border-radius: 8px; background: white; }
    `);
    ctx.register('document.html', (container, initial, scope) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', '');
      container.classList.add('reading-style-preview');
      container.append(frame);
      let revision = 0;
      let lastBlob;
      const update = (input) => {
        frame.title = input.filename;
        if (input.blob === lastBlob) return;
        lastBlob = input.blob;
        const current = ++revision;
        void input.blob.text().then((html) => {
          if (!scope.signal.aborted && current === revision) frame.srcdoc = html;
        }).catch(scope.reportError);
      };
      update(initial);
      return {
        update,
        dispose() { revision++; frame.remove(); container.classList.remove('reading-style-preview'); },
      };
    });
  },
};
