import { createContext, useContext, useEffect, useRef } from 'react';
import { useBeforeUnload, useBlocker } from 'react-router-dom';

export const DraftStateContext = createContext<(dirty: boolean) => void>(() => {});

export function useUnsavedChanges(dirty: boolean) {
  const reportDirty = useContext(DraftStateContext);
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
      <div className="modal-backdrop">
        <section
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="unsaved-title"
          className="panel discard-dialog"
          onKeyDown={(event) => {
            if (event.key === 'Escape') blocker.reset();
            if (event.key === 'Tab') {
              const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              event.preventDefault();
              buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
            }
          }}
        >
          <h2 id="unsaved-title">Leave without saving?</h2>
          <p>Your changes have not been saved.</p>
          <div className="actions">
            <button type="button" autoFocus onClick={() => blocker.reset()}>
              Keep editing
            </button>
            <button type="button" className="secondary" onClick={() => blocker.proceed()}>
              Discard changes
            </button>
          </div>
        </section>
      </div>
    ) : null;
  return { allowNavigation, prompt };
}
