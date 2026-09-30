import React from 'react'
import ReactDOM from 'react-dom/client'
// Fonts are bundled, not fetched from a CDN: works offline and leaks nothing to third parties.
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
