import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useBeforeUnload, useBlocker } from 'react-router-dom';
import { Modal } from './ui';

export const DraftStateContext = createContext<(dirty: boolean) => void>(() => {});

/**
 * Warns before unsaved work is left behind (W13). With `saveDraft`, the warning also offers
 * "Save draft and leave".
 */
export function useUnsavedChanges(dirty: boolean, saveDraft?: () => Promise<void>) {
  const reportDirty = useContext(DraftStateContext);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    reportDirty(dirty);
    return () => reportDirty(false);
  }, [dirty, reportDirty]);
  const allowNavigation = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !allowNavigation.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useBeforeUnload((event) => {
    if (dirty && !allowNavigation.current) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  const prompt =
    blocker.state === 'blocked' ? (
      <Modal
        alert
        title="Leave without saving?"
        onClose={() => blocker.reset()}
        footer={
          <>
            <button type="button" data-autofocus className="secondary" onClick={() => blocker.reset()}>
              Keep editing
            </button>
            {saveDraft && (
              <button
                type="button"
                className="secondary"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  await saveDraft();
                  setSaving(false);
                  blocker.proceed();
                }}
              >
                Save draft and leave
              </button>
            )}
            <button type="button" className="danger" onClick={() => blocker.proceed()}>
              Discard changes
            </button>
          </>
        }
      >
        <p>Your changes have not been saved.</p>
      </Modal>
    ) : null;
  return { allowNavigation, prompt };
}
