import { useCallback, useEffect, useRef, useState } from 'react'
import { createDrill, deleteDrill, listDrills, updateDrill, type DrillSummary } from '../api/drills'
import { ApiError } from '../types'

export type Item = DrillSummary & { pending?: boolean }

export function messageOf(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Please try again.'
}

/** Your drills with optimistic create / rename / delete: the screen updates at once, and puts things back
 *  (with a message) if the server says no. */
export function useDrills() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [limit, setLimit] = useState(10)
  const [loadError, setLoadError] = useState('')
  const tempId = useRef(0)

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const res = await listDrills()
      setItems(res.drills)
      setLimit(res.limit)
    } catch (e) {
      setItems((cur) => cur ?? [])
      setLoadError(messageOf(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** Resolves with the new drill; rejects with an ApiError the form can show inline. */
  const create = useCallback(async (name: string, notes: string): Promise<DrillSummary> => {
    tempId.current -= 1
    const id = tempId.current
    const now = new Date().toISOString()
    const temp: Item = { id, name: name.trim(), notes: notes.trim(), status: 'new', dataset: '', created_at: now, updated_at: now, events: 0, reports: 0, pending: true }
    setItems((cur) => [temp, ...(cur ?? [])])
    try {
      const real = await createDrill({ name, notes })
      setItems((cur) => (cur ?? []).map((d) => (d.id === id ? real : d)))
      return real
    } catch (e) {
      setItems((cur) => (cur ?? []).filter((d) => d.id !== id))
      throw e
    }
  }, [])

  const rename = useCallback(async (id: number, name: string): Promise<void> => {
    const before = items?.find((d) => d.id === id)
    setItems((cur) => (cur ?? []).map((d) => (d.id === id ? { ...d, name: name.trim(), pending: true } : d)))
    try {
      const real = await updateDrill(id, { name })
      setItems((cur) => (cur ?? []).map((d) => (d.id === id ? real : d)))
    } catch (e) {
      if (before) setItems((cur) => (cur ?? []).map((d) => (d.id === id ? before : d)))
      throw e
    }
  }, [items])

  const remove = useCallback(async (id: number): Promise<void> => {
    const index = (items ?? []).findIndex((d) => d.id === id)
    const before = items?.[index]
    setItems((cur) => (cur ?? []).filter((d) => d.id !== id))
    try {
      await deleteDrill(id)
    } catch (e) {
      if (before) setItems((cur) => { const next = [...(cur ?? [])]; next.splice(Math.min(index, next.length), 0, before); return next })
      throw e
    }
  }, [items])

  return { items, limit, loadError, reload: load, create, rename, remove }
}
