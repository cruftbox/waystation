// Theme choice: System (follow the OS), Light or Dark. Loaded without defer
// so the saved choice applies before first paint. Every page includes it.
(function () {
  const KEY = 'parlor_theme'
  const root = document.documentElement
  function apply(t) {
    if (t === 'light' || t === 'dark') root.dataset.theme = t
    else delete root.dataset.theme
  }
  let saved = null
  try { saved = localStorage.getItem(KEY) } catch { /* storage blocked */ }
  apply(saved)
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('theme')
    if (!select) return
    select.value = root.dataset.theme ?? 'system'
    select.addEventListener('change', () => {
      apply(select.value)
      try {
        if (select.value === 'system') localStorage.removeItem(KEY)
        else localStorage.setItem(KEY, select.value)
      } catch { /* storage blocked: choice lasts for this page only */ }
    })
  })
})()
