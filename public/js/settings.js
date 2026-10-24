import { storedToken } from './auth.js'
import { $, icon } from './dom.js'
import { changeLocale } from './i18n/dom.js'
import { LOCALE_NAMES, locale, t } from './i18n/index.js'
import { openMenu } from './menus.js'
import { canNotify, notificationsLabel, notificationsOn, setNotifications, setSound, soundLabel } from './notify.js'
import { showShortcuts } from './shortcuts.js'
import { state } from './state.js'
import { THEME_MODES, isDark, onThemeChange, setThemeMode, themeMode } from './theme.js'
import { setUsageMeter, usageOn } from './usage.js'
import { canKeepAwake, keepAwakeOn, setKeepAwake } from './wake.js'

const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' }

function paintFooter() {
  const sound = $('#sound-toggle')
  sound.innerHTML = icon(state.sound ? 'bell' : 'bell-off')
  sound.setAttribute('aria-pressed', String(state.sound))
  sound.setAttribute('aria-label', soundLabel())
  sound.title = soundLabel()
  const theme = $('#theme-toggle')
  const label = t('settings.themeIs', { mode: t(`theme.${themeMode()}`) })
  theme.innerHTML = icon(THEME_ICON[themeMode()] ?? (isDark() ? 'moon' : 'sun'))
  theme.setAttribute('aria-label', label)
  theme.title = label
}

function toggleSound() {
  setSound(!state.sound)
  paintFooter()
}

export function initSettings({ onLocaleChange, onSignOut }) {
  paintFooter()
  onThemeChange(paintFooter)
  $('#sound-toggle').addEventListener('click', toggleSound)
  $('#theme-toggle').addEventListener('click', () => {
    const next = THEME_MODES[(THEME_MODES.indexOf(themeMode()) + 1) % THEME_MODES.length]
    setThemeMode(next)
  })
  $('#settings-btn').addEventListener('click', e => {
    openMenu(e.currentTarget, [
      { header: t('settings.theme') },
      ...THEME_MODES.map(mode => ({
        label: t(`theme.${mode}`),
        icon: THEME_ICON[mode],
        checked: themeMode() === mode,
        run: () => setThemeMode(mode),
      })),
      { header: t('settings.language') },
      ...Object.entries(LOCALE_NAMES).map(([code, name]) => ({
        label: name,
        checked: locale() === code,
        run: () => {
          changeLocale(code)
          paintFooter()
          onLocaleChange()
        },
      })),
      { separator: true },
      {
        label: soundLabel(),
        icon: state.sound ? 'bell' : 'bell-off',
        run: toggleSound,
      },
      {
        label: notificationsLabel(),
        icon: notificationsOn() ? 'bell' : 'bell-off',
        hint: canNotify() ? '' : t('settings.notifyNeedsHttps'),
        run: () => setNotifications(!notificationsOn()),
      },
      {
        label: t('settings.keepAwake'),
        icon: 'monitor',
        checked: keepAwakeOn(),
        hint: canKeepAwake() ? t('settings.keepAwakeHint') : t('settings.keepAwakeUnsupported'),
        run: () => setKeepAwake(!keepAwakeOn()),
      },
      {
        label: t('usage.title'),
        icon: 'cpu',
        checked: usageOn(),
        hint: t('usage.hint'),
        run: () => setUsageMeter(!usageOn()),
      },
      { label: t('shortcuts.title'), icon: 'cmd', run: showShortcuts },
      // With auth off there is no token to forget.
      storedToken() && { separator: true },
      storedToken() && { label: t('settings.signOut'), icon: 'x', run: onSignOut },
    ])
  })
}
