import { useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { ApiError } from '../types'
import FormField from './FormField'
import Modal from './Modal'

/** Deleting an account removes every drill it owns, so the password is asked again — and the answer is shown inline. */
export default function DeleteAccountDialog({ onClose, onDelete }: { onClose: () => void; onDelete: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    if (!password) return setError('Enter your password to confirm.')
    setError('')
    setBusy(true)
    try {
      await onDelete(password)
    } catch (e) {
      setError(e instanceof ApiError ? e.fields.password ?? e.message : 'Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  return (
    <Modal title="Delete Your Account?" describedBy="delete-account-body" onClose={onClose} initialFocus="input">
      <form onSubmit={submit} noValidate>
        <p id="delete-account-body" className="mt-2 text-base text-ink-2">
          Your account and every drill, report and audit log in it are removed for good. This cannot be undone.
        </p>
        <div className="mt-3">
          <FormField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} error={error} autoComplete="current-password" />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-11 rounded-md border border-line bg-hi px-4 text-base font-semibold text-ink hover:border-accent">Cancel</button>
          <button type="submit" disabled={busy} className="inline-flex h-11 items-center gap-2 rounded-md bg-p1 px-4 text-base font-bold text-on-tier hover:brightness-110 disabled:opacity-60">
            {busy && <Loader2 size={16} className="animate-spin" aria-hidden />}Delete Account
          </button>
        </div>
      </form>
    </Modal>
  )
}
