import Modal from './Modal'

/** Replaces window.confirm: an in-page, accessible confirmation with a clearly labelled outcome. */
export default function ConfirmDialog({
  title, body, confirmLabel, danger = false, busy = false, onConfirm, onCancel,
}: {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal title={title} describedBy="confirm-body" onClose={onCancel} initialFocus="[data-cancel]">
      <p id="confirm-body" className="mt-2 text-base text-ink-2">{body}</p>
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" data-cancel onClick={onCancel} className="h-11 rounded-md border border-line bg-hi px-4 text-base font-semibold text-ink hover:border-accent">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className={`h-11 rounded-md px-4 text-base font-bold disabled:opacity-50 ${danger ? 'bg-p1 text-on-tier' : 'bg-accent text-bg'}`}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
