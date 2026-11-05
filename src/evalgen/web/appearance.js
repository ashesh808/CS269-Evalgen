// Pre-paint appearance boot, mirroring the kkuroma.github.io contract:
// a THEMES palette (themes.js) written onto :root as --name variables,
// plus a light/dark/system variant and a base font size, persisted per browser
(function () {
  const KEY = 'evalgen-state';
  const SIZES = { small: '14px', medium: '16px', large: '18px', xlarge: '20px' };
  const DEFAULTS = { theme: 'Natsumikan', variant: 'dark', fontSize: 'medium' };
  const dark = window.matchMedia('(prefers-color-scheme: dark)');

  function load() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY)) || {});
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function apply(state) {
    const root = document.documentElement;
    let variant = state.variant;
    if (variant === 'system') variant = dark.matches ? 'dark' : 'light';
    const palette = (THEMES[state.theme] || THEMES[DEFAULTS.theme])[variant];
    Object.entries(palette).forEach(([name, value]) => root.style.setProperty(`--${name}`, value));
    root.style.setProperty('--font-size-base', SIZES[state.fontSize] || SIZES.medium);
    root.style.colorScheme = variant;
  }

  function update(key, value) {
    const state = load();
    state[key] = value;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage blocked */ }
    apply(state);
    return state;
  }

  apply(load());
  dark.addEventListener('change', () => apply(load()));
  window.appearance = { load, update };
})();
