// Assertions are specific to the interactive preview's two documented placements.
import assert from 'node:assert/strict';

const surface = '.interactive-preview__surface';
const controls = '.interactive-preview__controls';
const card = id => `[data-preview-artifact="${id}"]`;
const sizes = [
  { pane: 1180, width: 1440, height: 900, font: 14, zoom: 1 },
  { pane: 510, width: 1280, height: 800, font: 12, zoom: 1 },
  { pane: 390, width: 680, height: 620, font: 18, zoom: 1.25 },
  { pane: 700, width: 860, height: 430, font: 16, zoom: 0.85 },
];
const close = (a, b, tolerance = 1.25) => Math.abs(a - b) <= tolerance;
function observe(selector) {
  const el = document.querySelector(selector);
  const box = node => {
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  };
  const toolbar = el.querySelector('.interactive-preview__controls');
  return {
    pane: box(el.closest('.local-agent__body') ?? el.querySelector('.interactive-preview__body')),
    body: box(el.querySelector('.interactive-preview__body')), frame: box(el.querySelector('iframe')),
    controls: toolbar && box(toolbar), visible: toolbar && getComputedStyle(toolbar).visibility === 'visible',
  };
}
export async function checkPreviewLayout({ navigate, evaluate, cmd, until, frame, click, key, record }) {
  const ids = ['small', 'fixed', 'application'];
  const metrics = id => evaluate(`(${observe})(${JSON.stringify(card(id))})`);
  const configure = async ({ pane, width, height, font, zoom }) => {
    await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.previewLayout.configure(${pane},${font},${zoom})`); await frame();
  };
  const visible = id => `(getComputedStyle(document.querySelector('${card(id)} ${controls}')).visibility==="visible")`;
  const scroll = async id => { await evaluate(`document.querySelector('${card(id)}').scrollIntoView({block:'start'})`); await frame(); };
  const count = n => until(`window.previewLayout.activations()===${n}`);
  const waitSized = async id => {
    const selector = id === 'application' ? card(id) + ' ' + surface + '[data-preview-layout="adaptive"]' : card(id) + '[style*="--preview-ideal-width"]';
    await until(`document.querySelector('${selector}') && document.querySelector('${card(id)}').dataset.previewReady==="true"`);
  };
  await navigate('preview-layout');
  for (const id of ids) await waitSized(id);
  await evaluate('window.layoutFrames = [...document.querySelectorAll("iframe")].map(f => f.contentWindow)');
  for (const size of sizes) {
    await configure(size);
    const measured = {};
    let pass = true;
    for (const id of ids) {
      const m = measured[id] = await metrics(id);
      pass &&= close(m.body.left + m.body.width / 2, m.pane.left + m.pane.width / 2)
        && m.body.left >= m.pane.left - 1 && m.body.right <= m.pane.right + 1
        && m.controls.bottom <= m.frame.top + 1 && m.visible === false;
    }
    const { small, fixed, application } = measured;
    pass &&= close(small.frame.width, 48 * size.zoom, 2) && close(small.frame.height, 36 * size.zoom, 2)
      && close(fixed.frame.width, Math.min(640 * size.zoom, application.frame.width), 2)
      && close(fixed.frame.height, fixed.frame.width * 140 / 640, 2)
      && application.frame.height > 0 && application.frame.height <= size.height
      && await evaluate('[...document.querySelectorAll("iframe")].every((f,i)=>f.contentWindow===window.layoutFrames[i])');
    await record('preview-inline-' + size.pane, { size, measured }, pass);
  }
  await configure(sizes[0]); await scroll('small');
  const small = (await metrics('small')).frame;
  const point = { x: small.left + small.width / 2, y: small.top + small.height / 2 };
  await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await frame();
  assert.equal(await evaluate(visible('small')), false, 'hover alone showed the preview toolbar');
  await click(card('small') + ' iframe'); await count(1); await until(visible('small'));
  await click('#outside'); await until('!' + visible('small'));
  for (let i = 0; i < 4 && !await evaluate(`document.activeElement.matches('${card('small')}')`); i++) await key('Tab');
  assert.ok(await evaluate(visible('small')), 'keyboard focus did not reveal the inline actions');
  await key('Tab');
  assert.ok(await evaluate(`document.activeElement.matches('${card('small')} [data-ui-part="more"]')`), 'More is not the first toolbar action');
  await key('Enter');
  await until(`document.activeElement.closest('${card('small')}') && document.querySelector('${card('small')} [data-ui-part="more"]').getAttribute('aria-expanded')==='true'`);
  const more = await metrics('small');
  const names = await evaluate(`[...document.querySelectorAll('${card('small')} ${controls} button')].map(b=>b.getAttribute('aria-label') || b.textContent.trim())`);
  await record('preview-focus-and-actions', { before: small, after: more, names },
    names.every(Boolean) && close(small.top, more.frame.top) && more.controls.bottom <= more.frame.top);
  await scroll('application');
  await evaluate(`document.querySelector('${card('application')}').focus({preventScroll:true})`);
  await click(card('application') + ' [data-ui-part="more"]');
  const app = await metrics('application');
  const target = { x: app.frame.right - 26, y: app.frame.top + 18 };
  assert.ok(await evaluate(`document.elementFromPoint(${target.x},${target.y})===document.querySelector('${card('application')} iframe')`),
    'host intercepted the document’s top-right control: ' + JSON.stringify({ app, target }));
  for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, ...target, button: 'left', clickCount: 1 });
  await count(2);
  await until(`document.querySelector('${card('application')} [data-ui-part="more"]').getAttribute('aria-expanded')==='false'`);
  await click('#outside'); await until('!' + visible('application'));
  await configure(sizes[2]); await scroll('small');
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const touch = async (x, y) => {
    await cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const touchFrame = (await metrics('small')).frame;
  await touch(touchFrame.left + touchFrame.width / 2, touchFrame.top + touchFrame.height / 2);
  await count(3); await until(visible('small'));
  const outside = await evaluate('document.querySelector("#outside").getBoundingClientRect().toJSON()');
  await touch(outside.left + outside.width / 2, outside.top + outside.height / 2);
  await until('!' + visible('small'));
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: false });
  for (const id of ids) {
    await navigate('preview-layout', { reader: id }); await waitSized(id);
    await evaluate('window.readerFrame=document.querySelector("iframe").contentWindow');
    for (const size of [sizes[0], sizes[2]]) {
      await configure(size);
      const { body, frame: f } = await metrics(id);
      const centered = close(f.left + f.width / 2, body.left + body.width / 2) && close(f.top + f.height / 2, body.top + body.height / 2);
      const fits = id === 'application' ? close(f.width, body.width) && close(f.height, body.height)
        : close(f.width, Math.min(body.width, (id === 'small' ? 48 : 640) * size.zoom), 2)
          && close(f.height, f.width * (id === 'small' ? 36 / 48 : 140 / 640), 2);
      await record(`preview-reader-${id}-${size.pane}`, { body, frame: f, size }, centered && fits
        && await evaluate('document.querySelector("iframe").contentWindow === window.readerFrame'));
    }
  }
}
