// Native macOS adapter. Only tab.fontName/fontSize are changed; never a settings set.
ObjC.import('AppKit');
ObjC.import('CoreText');

function prepareFont(config) {
  let font = $.NSFont.fontWithNameSize(config.name, config.size);
  if (!ObjC.unwrap(font.fontName)) {
    if (!config.file) throw new Error('Font is not installed: ' + config.name);
    const error = Ref();
    const url = $.NSURL.fileURLWithPath(config.file);
    // Session registration exposes the bundled face to Terminal without installing
    // files in ~/Library/Fonts or changing any application's default font.
    if (!$.CTFontManagerRegisterFontsForURL(url, $.kCTFontManagerScopeSession, error)) {
      const description = $.CFErrorCopyDescription(error[0]);
      throw new Error(ObjC.unwrap(ObjC.castRefToObject(description)));
    }
    font = $.NSFont.fontWithNameSize(config.name, config.size);
  }
  const name = ObjC.unwrap(font.fontName);
  if (!name) throw new Error('Font did not become available: ' + config.name);
  if (!font.fixedPitch) throw new Error('Terminal requires a fixed-width font. Choose a Achbit built-in font or a monospaced custom font: ' + name);
  return { name: name, size: config.size };
}

function recordOwner(path, owner) {
  const data = $(JSON.stringify(owner)).dataUsingEncoding($.NSUTF8StringEncoding);
  if (!data.writeToFileAtomically(path, true)) throw new Error('Could not record the new Terminal window: ' + path);
}

function run(argv) {
  const mode = argv[0];
  const config = JSON.parse(argv[1]);
  if (mode === 'prepare') return JSON.stringify(prepareFont(config));
  const terminal = Application('/System/Applications/Utilities/Terminal.app');
  if (mode === 'create') {
    const previous = terminal.running() ? terminal.windows.id() : [];
    const tab = terminal.doScript(config.command);
    let created = terminal.windows().filter(w => previous.indexOf(w.id()) < 0);
    if (created.length > 1) {
      // Cold startup may restore unrelated windows alongside the requested tab.
      const tty = tab.tty();
      created = created.filter(w => w.tabs().some(candidate => candidate.tty() === tty));
    }
    if (created.length !== 1) throw new Error('Terminal did not create a separate Achbit window.');
    const window = created[0];
    // Persist identity before tab lookup, title, font, bounds, or activation can fail.
    const owner = { windowId: window.id(), tty: null };
    recordOwner(config.ownerPath, owner);
    owner.tty = tab.tty();
    recordOwner(config.ownerPath, owner);
    if (window.tabs().length !== 1 || window.tabs()[0].tty() !== owner.tty) {
      throw new Error('Terminal did not create a separate Achbit tab.');
    }
    return JSON.stringify(owner);
  }
  if (!terminal.running()) {
    if (mode === 'close' || mode === 'closeFinished') return JSON.stringify({ closed: true });
    if (mode === 'restore') return JSON.stringify({ restored: false });
    throw new Error('The Achbit terminal window is closed.');
  }
  if (mode === 'close' || mode === 'closeFinished') {
    const windows = terminal.windows().filter(w => w.id() === config.windowId);
    if (windows.length === 0) return JSON.stringify({ closed: true });
    const tabs = windows[0].tabs();
    if (tabs.length !== 1 || (config.tty && tabs[0].tty() !== config.tty)) {
      if (mode === 'closeFinished') return JSON.stringify({ closed: false });
      throw new Error('The owned window changed; refusing to close unrelated tabs.');
    }
    if (mode === 'closeFinished' && (!config.tty || tabs[0].busy() || tabs[0].processes().length !== 0)) {
      return JSON.stringify({ closed: false });
    }
    terminal.close(windows[0], { saving: 'no' });
    return JSON.stringify({ closed: true });
  }
  if (!['capture', 'apply', 'restore'].includes(mode)) throw new Error('Unknown terminal font action: ' + mode);
  const matches = [];
  terminal.windows().forEach(w => w.tabs().forEach(t => {
    if (t.tty() === config.tty && (config.windowId === undefined || w.id() === config.windowId)) {
      matches.push({ tab: t, window: w });
    }
  }));
  if (mode === 'restore' && matches.length === 0) return JSON.stringify({ restored: false });
  if (matches.length !== 1) throw new Error('The Achbit terminal tab was not found.');
  const { tab, window } = matches[0];
  if (mode === 'capture') {
    return JSON.stringify({ windowId: window.id(), tty: tab.tty(), name: tab.fontName(), size: tab.fontSize(), title: tab.customTitle() });
  }
  const bounds = window.bounds();
  tab.fontName = config.name;
  tab.fontSize = config.size;
  window.bounds = bounds;
  if (tab.fontName() !== config.name || tab.fontSize() !== config.size) throw new Error('Terminal did not apply the selected font.');
  tab.customTitle = mode === 'restore' ? config.title : 'AC';
  if (mode === 'apply' && config.windowId !== undefined) terminal.activate();
  return JSON.stringify({ windowId: window.id(), tty: tab.tty(), name: tab.fontName(), size: tab.fontSize() });
}
