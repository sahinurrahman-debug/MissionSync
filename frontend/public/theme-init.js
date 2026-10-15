// Restore the saved theme before first paint (no flash of the wrong theme).
// An external file, not an inline <script>: the Content-Security-Policy only allows scripts from this origin.
try {
  var t = localStorage.getItem('ms-theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch (e) { /* storage blocked: the default theme applies */ }
