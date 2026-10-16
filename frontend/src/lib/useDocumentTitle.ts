import { useEffect } from 'react'

/** Every page names itself in the tab and in screen-reader page-change announcements. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} — MissionSync`
  }, [title])
}
