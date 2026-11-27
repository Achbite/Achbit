import assert from 'node:assert/strict';

// Measure the production controls, not just the <img>: an oversized button is a letterbox too.
export async function checkAttachmentThumbnails({ navigate, evaluate, cmd, until, frame, click, key, record }) {
  await navigate('messages', { thumbnails: '1' });
  const sent = '.local-agent__message-attachments .local-agent__message-image';
  const draft = '.local-agent__image-attachment > .conversation-image-review__open';
  const rail = '.local-agent__draft-attachments';
  const editor = '[data-ui-action="composer.controls.input"]';
  await until(`document.querySelectorAll('${sent} > img').length === 4 && [...document.querySelectorAll('${sent} > img')].every(i => i.complete && i.naturalWidth)`);
  // Paste local PNGs via the actual composer handler. Avoid the system clipboard and any real Session.
  await evaluate(`(async () => {
    const data = new DataTransfer();
    for (const i of document.querySelectorAll('${sent} > img')) {
      const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
      c.getContext('2d').drawImage(i, 0, 0);
      data.items.add(new File([await new Promise(done => c.toBlob(done, 'image/png'))], i.alt.replace('.svg', '.png'), {type: 'image/png'}));
    }
    const editor = document.querySelector('${editor}'); editor.focus();
    editor.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  })()`);
  await until(`document.querySelectorAll('${draft} > img').length === 4 && [...document.querySelectorAll('${draft} > img')].every(i => i.complete && i.naturalWidth)`);
  for (const width of [1080, 320]) {
    await cmd('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme = '${width === 320 ? 'dark' : 'light'}'`); await frame();
    const geometry = await evaluate(`(() => {
      const inspect = (selector) => [...document.querySelectorAll(selector)].map(b => {
        const i = b.querySelector('img'), s = getComputedStyle(b), box = b.getBoundingClientRect(), r = i.getBoundingClientRect();
        return { natural: [i.naturalWidth, i.naturalHeight], image: [r.width, r.height], button: [box.width, box.height],
          noFrame: s.borderTopWidth === '0px' && s.padding === '0px' && s.backgroundColor === 'rgba(0, 0, 0, 0)' };
      });
      const rail = document.querySelector('${rail}');
      const tiles = [...rail.querySelectorAll('.local-agent__image-attachment')];
      return { sent: inspect('${sent}'), draft: inspect('${draft}'),
        compactTiles: tiles.every(el => Math.abs(el.getBoundingClientRect().width - Math.max(48, el.firstElementChild.getBoundingClientRect().width)) < 1),
        pageFits: document.documentElement.scrollWidth <= innerWidth, draftScrolls: rail.scrollWidth > rail.clientWidth,
        tileIsClear: tiles.every(e => {const s=getComputedStyle(e);return s.borderWidth === '0px' && s.backgroundColor === 'rgba(0, 0, 0, 0)';}) };
    })()`);
    for (const [items, maxWidth, maxHeight] of [[geometry.sent, 256, 160], [geometry.draft, 176, 96]]) {
      for (const { natural: [nw, nh], image: [w, h], button: [bw, bh], noFrame } of items) {
        assert.ok(w > 0 && h > 0 && w <= Math.min(nw, maxWidth) + 1 && h <= Math.min(nh, maxHeight) + 1 && Math.abs(h - w * nh / nw) < 1, 'full image fits without distortion: ' + JSON.stringify(geometry));
        assert.ok(noFrame && Math.abs(bw - Math.max(24, w)) < 1 && Math.abs(bh - Math.max(24, h)) < 1, 'the button hugs the image, apart from the minimum hit target: ' + JSON.stringify(geometry));
      }
    }
    assert.ok(geometry.sent[0].image[0] > 128 && geometry.draft[0].image[0] > 80 && geometry.tileIsClear && geometry.compactTiles && geometry.pageFits, JSON.stringify(geometry));
    assert.equal(geometry.draftScrolls, width === 320, 'scroll only when the thumbnails do not fit');
    await record('attachment-thumbnails-' + width, geometry, true);
  }
  // A split pane can be narrower than the transcript's usual thumbnail limit.
  await evaluate(`document.querySelector('.fixture-main').style.width = '220px'`); await frame();
  const fitsPane = await evaluate(`(() => {
    const b = document.querySelector('${sent}'), group = b.closest('.local-agent__message-attachments').getBoundingClientRect(), r = b.querySelector('img').getBoundingClientRect();
    return r.width < 256 && r.left >= group.left - 1 && r.right <= group.right + 1 && Math.abs(r.height - r.width * 810 / 1440) < 1;
  })()`);
  assert.ok(fitsPane, 'a sent image also scales down to the available column width');
  await evaluate(`document.querySelector('.fixture-main').style.removeProperty('width')`); await frame();
  // Reflow can move transcript rows as the viewport follows the latest message. Activate the named image by keyboard.
  await evaluate(`document.querySelector('${sent}').focus()`); await key('Enter');
  await until('document.querySelector(".conversation-image-review__dialog[open][data-lightbox] img")?.naturalWidth === 1440');
  assert.equal(await evaluate('window.openedMessageAttachment'), undefined, 'viewing an image stays in place');
  await key('Escape'); await until('!document.querySelector(".conversation-image-review__dialog[open]")');
  const remove = '.local-agent__image-attachment-remove';
  await click(draft); await until('document.querySelector(".conversation-image-review__dialog[open]")');
  await key('Escape'); await until('!document.querySelector(".conversation-image-review__dialog[open]")');
  // Only this draft image is removed; the sent resource references and all other images survive.
  await evaluate(`document.querySelector('${draft}').focus()`); await key('Tab');
  assert.ok(await evaluate(`document.activeElement.matches('${remove}') && getComputedStyle(document.activeElement).opacity === '1'`));
  await key('Enter'); await until(`document.querySelectorAll('${draft}').length === 3`);
  assert.equal(await evaluate(`document.querySelectorAll('${sent}').length`), 4);
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
}
