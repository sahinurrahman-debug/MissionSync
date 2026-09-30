/** Design tokens live as CSS variables (see src/index.css) so the dark "Tactical Night"
 *  and high-contrast "Day" themes swap without touching a single class name. */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        panel: token('panel'),
        hi: token('panel-hi'),
        line: token('line'),
        ink: token('ink'),
        'ink-2': token('ink-2'),
        muted: token('muted'),
        accent: token('accent'),
        p1: token('p1'),
        p2: token('p2'),
        p3: token('p3'),
        p4: token('p4'),
        ok: token('ok'),
        route: token('route'),
        scene: token('scene'),
        ret: token('ret'),
        warn: token('warn'),
        'on-tier': token('on-tier'),
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', 'JetBrains Mono', 'ui-monospace', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      // Secondary text is 15px (not 14): primary content is 16px, only uppercase micro-labels stay at 12px.
      fontSize: { sm: ['0.9375rem', { lineHeight: '1.4' }] },
      borderRadius: { DEFAULT: '6px', md: '6px', lg: '8px' },
      boxShadow: {
        panel: '0 4px 12px rgba(0, 0, 0, 0.4)',
        glow: '0 0 0 1px rgb(var(--accent) / 0.5), 0 0 12px rgb(var(--accent) / 0.25)',
      },
      letterSpacing: { tightish: '-0.01em', micro: '0.08em' },
      keyframes: {
        ping2: { '0%': { transform: 'scale(0.6)', opacity: '0.7' }, '80%,100%': { transform: 'scale(2.4)', opacity: '0' } },
        sweep: { to: { transform: 'rotate(360deg)' } },
        shimmer: { from: { backgroundPosition: '200% 0' }, to: { backgroundPosition: '-200% 0' } },
        'fade-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
        'stage-glow': {
          '0%,100%': { boxShadow: '0 0 0 0 rgb(var(--accent) / 0)' },
          '50%': { boxShadow: '0 0 0 3px rgb(var(--accent) / 0.25)' },
        },
      },
      animation: {
        ping2: 'ping2 2.2s cubic-bezier(0, 0, 0.2, 1) infinite',
        sweep: 'sweep 4s linear infinite',
        shimmer: 'shimmer 2s linear infinite',
        'fade-up': 'fade-up 240ms ease-out both',
        'stage-glow': 'stage-glow 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
