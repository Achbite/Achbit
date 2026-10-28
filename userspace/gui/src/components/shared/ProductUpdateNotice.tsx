import { useState, useSyncExternalStore } from 'react';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import { productUpdateSnapshot, subscribeProductUpdates, checkProductUpdate } from '../../services/productUpdates';
import AchbitShellIcon from './AchbitShellIcon';
import './productUpdateNotice.css';

export function ProductUpdateNotice() {
  const language = useUiLanguage();
  const update = useSyncExternalStore(subscribeProductUpdates, productUpdateSnapshot);
  const [retryError, setRetryError] = useState<string | null>(null);
  if (!['downloading', 'waiting', 'preparing', 'installing', 'error'].includes(update.phase)) return null;
  const label = ['preparing', 'installing'].includes(update.phase) ? 'installing' : update.phase;
  const progress = update.phase === 'downloading' && update.total
    ? Math.min(100, Math.max(0, Math.floor(update.downloaded * 100 / update.total))) : null;
  const description = [t(language, `productUpdate.${label}`, { version: update.version ?? '' }),
    progress === null ? null : `${progress}%`]
    .filter(Boolean).join(' · ');
  const error = retryError ?? update.error;
  return <div className="product-update-notice" role="status" data-product-update={update.phase}>
    {update.phase === 'error' ? <button type="button" className="product-update-notice__icon"
      title={[description, error, t(language, 'productUpdate.retry')].filter(Boolean).join('\n')}
      aria-label={`${description}. ${t(language, 'productUpdate.retry')}`}
      onClick={() => {
        setRetryError(null);
        void checkProductUpdate().catch(reason => setRetryError(String(reason)));
      }}><AchbitShellIcon name="download" /></button>
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
  </div>;
}
