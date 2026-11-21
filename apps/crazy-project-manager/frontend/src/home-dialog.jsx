import { useEffect, useRef } from 'react';
import { t } from './i18n.js';

export function HomeDialog({ id, className, title, focusSelector, onClose, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node.open) node.showModal();
    if (focusSelector) node.querySelector(focusSelector)?.focus();
  }, [focusSelector]);

  const close = () => dialog.current?.close();
  return (
    <dialog
      ref={dialog}
      id={id}
      className={`home-dialog ${className}`}
      aria-labelledby={id + '-title'}
      onClose={onClose}
    >
      <div className="dialog-banner">
        <h2 id={id + '-title'}>{title}</h2>
        <button className="dialog-close" type="button" onClick={close} aria-label={t(`关闭${title}`, `Close ${title}`)}>×</button>
      </div>
      {children(close)}
    </dialog>
  );
}
