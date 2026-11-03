/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Replaced, not extended, so the whole app shares one small set of
    // corners: controls at 6px, cards at 8px, the product frame at 12px.
    borderRadius: {
      none: '0',
      sm: '3px',
      DEFAULT: '4px',
      md: '6px',
      lg: '8px',
      xl: '12px',
      full: '9999px',
    },
    // A fixed rem scale at roughly 1.2 between steps. Product UI reads at
    // one DPI, so fluid type would only make the sidebar's headings shrink.
    fontSize: {
      '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      xs: ['0.75rem', { lineHeight: '1.05rem' }],
      sm: ['0.8125rem', { lineHeight: '1.25rem' }],
      base: ['0.9375rem', { lineHeight: '1.45rem' }],
      lg: ['1.125rem', { lineHeight: '1.6rem' }],
      xl: ['1.375rem', { lineHeight: '1.8rem' }],
      '2xl': ['1.75rem', { lineHeight: '2.15rem' }],
      '3xl': ['2.25rem', { lineHeight: '2.6rem' }],
      '4xl': ['3rem', { lineHeight: '3.3rem' }],
      '5xl': ['3.75rem', { lineHeight: '4rem' }],
    },
    extend: {
      colors: {
        // Every colour is a token in src/index.css, defined twice: light for
        // the website, dark for the signed-in app. Components never carry a
        // hex literal.
        ground: 'rgb(var(--ground) / <alpha-value>)',
        panel: 'rgb(var(--panel) / <alpha-value>)',
        'panel-2': 'rgb(var(--panel-2) / <alpha-value>)',
        'panel-3': 'rgb(var(--panel-3) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        'line-strong': 'rgb(var(--line-strong) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'ink-2': 'rgb(var(--ink-2) / <alpha-value>)',
        'ink-3': 'rgb(var(--ink-3) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-ink': 'rgb(var(--accent-ink) / <alpha-value>)',
        'accent-soft': 'rgb(var(--accent-soft) / <alpha-value>)',
        'accent-deep': 'rgb(var(--accent-deep) / <alpha-value>)',
        select: 'rgb(var(--select) / <alpha-value>)',
        monitor: 'rgb(var(--monitor) / <alpha-value>)',
        good: 'rgb(var(--good) / <alpha-value>)',
        'good-soft': 'rgb(var(--good-soft) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        'warn-soft': 'rgb(var(--warn-soft) / <alpha-value>)',
        bad: 'rgb(var(--bad) / <alpha-value>)',
        'bad-soft': 'rgb(var(--bad-soft) / <alpha-value>)',
        // Clip kinds on the timeline, so a track reads at a glance.
        'kind-clip': 'rgb(var(--kind-clip) / <alpha-value>)',
        'kind-photo': 'rgb(var(--kind-photo) / <alpha-value>)',
        'kind-asset': 'rgb(var(--kind-asset) / <alpha-value>)',
        'kind-solid': 'rgb(var(--kind-solid) / <alpha-value>)',
        cue: 'rgb(var(--cue) / <alpha-value>)',
        'cue-ink': 'rgb(var(--cue-ink) / <alpha-value>)',
      },
      fontFamily: {
        // Archivo for every Latin glyph, Mukta for Devanagari. The browser
        // picks per character by unicode-range, so a Hindi caption inside an
        // English sentence is set in the right face without a span.
        sans: ['"Archivo Variable"', 'Mukta', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        // Offset and blurred, for the few things that float: menus, toasts,
        // the product frame on the website.
        float: '0 8px 24px -6px rgb(0 0 0 / 0.28), 0 2px 6px -2px rgb(0 0 0 / 0.2)',
        frame: '0 30px 60px -20px rgb(20 20 20 / 0.35), 0 12px 24px -12px rgb(20 20 20 / 0.25)',
      },
      // 58ch, not the usual 66: `ch` is the width of a zero, which in Archivo
      // is wider than an average letter, and 66ch ran lines to ~90 characters.
      maxWidth: { content: '1200px', prose: '58ch' },
    },
  },
  plugins: [],
};
