import type { ReactNode } from 'react'
import { LINKS } from '../lib/links'

const link = 'inline-flex min-h-11 items-center rounded px-1 text-base text-ink-2 underline-offset-4 transition-colors hover:text-accent hover:underline sm:min-h-9'

function A({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={link}>{children}</a>
}

/** Site footer. `page` is the full version for sign-in, My drills and message pages; `compact` is the one-line strip
 *  under the dashboard (desktop only — on a phone the tab bar owns the bottom edge). */
export default function Footer({ variant = 'page' }: { variant?: 'page' | 'compact' }) {
  const year = new Date().getFullYear()
  if (variant === 'compact') {
    return (
      <footer className="hidden shrink-0 items-center gap-x-5 border-t border-line bg-panel px-4 text-base text-ink-2 lg:flex">
        <span className="font-semibold text-ink">Mission<span className="text-accent">Sync</span></span>
        <span>© {year} · MIT licence</span>
        <nav aria-label="Footer" className="ml-auto flex items-center gap-x-3">
          <A href={LINKS.apiDocs}>API docs</A>
          <A href={LINKS.howItWorks}>How it works</A>
          <A href={LINKS.source}>Source on GitHub</A>
          <A href={LINKS.notice}>Data credits</A>
        </nav>
      </footer>
    )
  }
  return (
    <footer className="mt-auto border-t border-line bg-panel text-ink">
      <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <p className="text-lg font-extrabold tracking-tight">Mission<span className="text-accent">Sync</span></p>
          <p className="mt-1 max-w-xs text-base text-ink-2">A private, AI-assisted practice board for emergency-response drills. Agents propose; you approve.</p>
        </div>
        <nav aria-label="Project">
          <h2 className="text-sm font-semibold uppercase tracking-micro text-ink-2">Project</h2>
          <ul className="mt-1 flex flex-col">
            <li><A href={LINKS.howItWorks}>How it works</A></li>
            <li><A href={LINKS.architecture}>Architecture</A></li>
            <li><A href={LINKS.apiDocs}>API documentation</A></li>
            <li><A href={LINKS.source}>Source code on GitHub</A></li>
          </ul>
        </nav>
        <nav aria-label="Credits">
          <h2 className="text-sm font-semibold uppercase tracking-micro text-ink-2">Data &amp; credits</h2>
          <ul className="mt-1 flex flex-col">
            <li><A href={LINKS.xbd}>xBD damage data (CC BY-NC-SA 4.0)</A></li>
            <li><A href={LINKS.osm}>© OpenStreetMap contributors</A></li>
            <li><A href={LINKS.groq}>AI agents on Groq</A></li>
            <li><A href={LINKS.license}>MIT licence</A></li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-line">
        <p className="mx-auto w-full max-w-5xl px-4 py-3 text-base text-ink-2">© {year} MissionSync · A training tool for drills — not for real emergencies.</p>
      </div>
    </footer>
  )
}
