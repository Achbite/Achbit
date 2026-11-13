import { useEffect, useState, useSyncExternalStore } from 'react';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import { productUpdateSnapshot, subscribeProductUpdates, requestProductUpdate, productUpdateConfirmation, respondProductUpdate } from '../../services/productUpdates';
import { useSettingsStore } from '../../state/settingsStore';
import AchbitShellIcon from './AchbitShellIcon';
import './productUpdateNotice.css';
import { ModalDialog } from '../../ui-components';
import { useUiOwner } from '../../ui-ownership/useUiOwner';

export function ProductUpdateNotice() {
  const identity = useUiOwner('product.update');
  const language = useUiLanguage();
  const confirmation = useSyncExternalStore(subscribeProductUpdates, productUpdateConfirmation, productUpdateConfirmation);
  const update = useSyncExternalStore(subscribeProductUpdates, productUpdateSnapshot, productUpdateSnapshot);
  const phase = confirmation ? 'confirming' : update.phase;
  const automatic = useSettingsStore(state => state.effectiveSettings['gui.autoUpdate'] === true);
  const [retryError, setRetryError] = useState<string | null>(null);
  useEffect(() => setRetryError(null), [update]);
  if (!['downloading', 'waiting', 'confirming', 'preparing', 'installing', 'error'].includes(phase)) return null;
  const label = ['preparing', 'installing'].includes(phase) ? 'installing'
    : phase === 'waiting' && !automatic ? 'ready' : phase;
  const progress = update.phase === 'downloading' && update.total
    ? Math.min(100, Math.max(0, Math.floor(update.downloaded * 100 / update.total))) : null;
  const description = [t(language, `productUpdate.${label}`, { version: update.version ?? '' }),
    progress === null ? null : `${progress}%`,
    update.reason ? t(language, `productUpdate.reason.${update.reason}`) : null]
    .filter(Boolean).join(' · ');
  const error = retryError ?? update.error;
  const action = t(language, update.phase === 'waiting' ? 'productUpdate.installNow' : 'productUpdate.retry');
  return <><div {...identity.part('notice')} className="product-update-notice" role="status" data-product-update={phase}>
    {['waiting', 'error'].includes(phase) ? <button type="button" className="product-update-notice__icon"
      title={[description, error, action].filter(Boolean).join('\n')}
      aria-label={[description, error, action].filter(Boolean).join('. ')}
      {...identity.action('install', 'click')} onClick={() => {
        setRetryError(null);
        void requestProductUpdate().catch(reason => {
          if (productUpdateSnapshot() === update) setRetryError(String(reason));
        });
      }}><AchbitShellIcon name={phase === 'error' ? 'warning' : 'refresh'} /></button>
      : <span className="product-update-notice__icon" tabIndex={0} title={description} aria-label={description}>
        {update.phase === 'downloading' && <svg className="product-update-notice__progress"
          viewBox="0 0 28 28" role="progressbar" aria-label={description}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}
          data-indeterminate={progress === null || undefined}>
          <circle className="product-update-notice__track" cx="14" cy="14" r="12" />
          <circle className="product-update-notice__value" cx="14" cy="14" r="12" pathLength="100"
            strokeDasharray={progress === null ? '25 75' : '100'} strokeDashoffset={progress === null ? 0 : 100 - progress} />
        </svg>}
        <AchbitShellIcon name="download" />
      </span>}
  </div>
    {confirmation && <ModalDialog aria-label={t(language, 'productUpdate.confirmTitle')}
      className="achbit-gui-text-dialog-backdrop" onClose={() => respondProductUpdate(false)}>
      <div {...identity.part('confirmation')} className="achbit-gui-text-dialog">
        <header><h2>{t(language, 'productUpdate.confirmTitle')}</h2></header>
        <p className="achbit-gui-text-dialog__message">{t(language, confirmation.busy ? 'productUpdate.confirmBusy' : 'productUpdate.confirmRestart')}</p>
        {confirmation.unsaved.length > 0 && <div className="achbit-gui-text-dialog__message">
          <p>{t(language, 'productUpdate.confirmUnsaved')}</p>
          <ul>{[...new Set(confirmation.unsaved)].map(label => <li key={label}>{label}</li>)}</ul>
        </div>}
        <footer><button {...identity.action('cancel', 'click')} autoFocus onClick={() => respondProductUpdate(false)}>{t(language, 'productUpdate.cancel')}</button>
          <button {...identity.action('confirm', 'click')} onClick={() => respondProductUpdate(true)}>{t(language, 'productUpdate.confirm')}</button></footer>
      </div>
    </ModalDialog>}
  </>;
}
