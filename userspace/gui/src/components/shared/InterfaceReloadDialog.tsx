import { useEffect, useState } from 'react';
import { interfaceReloadGuards, reloadInterface } from '../../services/interfaceReload';
import { useUiLanguage } from '../../useUiLanguage';
import ModalDialog from './ModalDialog';

export default function InterfaceReloadDialog() {
  const chinese = useUiLanguage() === 'zh-CN';
  const [pending, setPending] = useState<ReturnType<typeof interfaceReloadGuards> | null>(null);
  const [error, setError] = useState('');
  const reload = () => { try { reloadInterface(); } catch (reason) { setError(String(reason)); } };
  useEffect(() => {
    const request = () => {
      const guards = interfaceReloadGuards();
      setError('');
      if (guards.length) setPending(guards); else reload();
    };
    window.addEventListener('deepcode:request-interface-reload', request);
    return () => window.removeEventListener('deepcode:request-interface-reload', request);
  }, []);
  if (!pending && !error) return null;
  const busy = pending?.some(guard => guard.busy);
  return <ModalDialog className="achbit-gui-text-dialog-backdrop" aria-label={chinese ? '重新加载界面' : 'Reload interface'} onClose={() => { setPending(null); setError(''); }}>
    <div className="achbit-gui-text-dialog">
      <header><h2>{chinese ? '重新加载界面' : 'Reload interface'}</h2></header>
      <p>{busy ? (chinese ? '有配置正在保存，请完成后再重载。' : 'Settings are being saved. Reload after saving completes.') : (chinese ? '以下配置尚未保存。返回保存，或放弃这些修改后重载。' : 'These settings have unsaved changes. Return to save, or discard them and reload.')}</p>
      <ul>{[...new Set(pending?.map(guard => guard.label))].map(label => <li key={label}>{label}</li>)}</ul>
      {error && <p role="alert">{error}</p>}
      <footer><button onClick={() => { setPending(null); setError(''); }}>{chinese ? '返回' : 'Back'}</button>
        {!busy && <button onClick={reload}>{chinese ? '放弃修改并重载' : 'Discard and reload'}</button>}</footer>
    </div>
  </ModalDialog>;
}
