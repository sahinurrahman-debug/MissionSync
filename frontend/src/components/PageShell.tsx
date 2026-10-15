import type { ReactNode } from 'react'
import Footer from './Footer'

/** A scrolling page (sign-in, My drills, messages). The app shell locks the body, so each page owns its own vertical
 *  scrolling — and never scrolls sideways. The footer always sits at the bottom, even on a short page. */
export default function PageShell({ children, center = false }: { children: ReactNode; center?: boolean }) {
  return (
    <div className="flex h-dvh flex-col overflow-y-auto overflow-x-hidden bg-bg text-ink">
      <div className={`flex flex-1 flex-col ${center ? 'items-center justify-center' : ''}`}>{children}</div>
      <Footer />
    </div>
  )
}
