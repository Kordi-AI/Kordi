import { KordiFlyingBird } from './KordiFlyingBird';

export function CloudStartingScreen({
  status = 'syncing',
  onRetry,
  visible = true,
}: {
  visible?: boolean;
  status?: 'syncing' | 'error';
  onRetry?: () => void;
}) {
  return (
    <div
      className={`app-cloud-starting-screen ${status === 'error' ? 'app-cloud-starting-screen-error' : ''}`}
      data-visible={visible}
      aria-hidden={!visible}
      aria-live="polite"
      aria-busy={visible && status === 'syncing'}
      aria-label={status === 'error' ? 'Cloud sync timed out' : 'Preparing Kordi Cloud'}
    >
      <div className="app-cloud-starting-content">
        <KordiFlyingBird className="app-cloud-starting-bird" />
        {status === 'error' && onRetry ? (
          <button
            type="button"
            className="app-cloud-starting-retry"
            onClick={onRetry}
          >
            Retry sync
          </button>
        ) : null}
      </div>
    </div>
  );
}
