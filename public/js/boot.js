// Classic, render-blocking script: applies the saved theme and language before first paint (no flash).
try {
  const theme = JSON.parse(localStorage.getItem('herdr-web:theme') ?? 'null')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  const lang = JSON.parse(localStorage.getItem('herdr-web:lang') ?? 'null')
  if (typeof lang === 'string') document.documentElement.lang = lang
} catch {}
