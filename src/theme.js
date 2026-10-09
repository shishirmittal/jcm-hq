// App-wide dark mode. One localStorage flag + one class on <body> — every
// page's colors come from style.css's CSS variables reacting to that class,
// so nothing here needs to know what page is currently rendered.
const KEY = 'darkMode'

export function isDarkMode() {
  return localStorage.getItem(KEY) === 'true'
}

function applyTheme(dark) {
  document.body.classList.toggle('dark-mode', dark)
}

// Called once at boot, before anything renders, so there's no flash of the
// wrong theme on reload for a user who's already chosen dark mode.
export function initTheme() {
  applyTheme(isDarkMode())
}

export function toggleTheme() {
  const next = !isDarkMode()
  localStorage.setItem(KEY, String(next))
  applyTheme(next)
  return next
}
