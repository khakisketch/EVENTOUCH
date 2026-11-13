import {defineTheme} from '@astryxdesign/core/theme';
import {neutralTheme} from '@astryxdesign/theme-neutral/built';

// Eventouch product theme. Extends Neutral and re-points coherent token
// roles at the canonical app variables (apps/web/app/tokens.css), which
// remain the value source of truth. Aliases only: no color interpolation,
// so built text/background pairs keep their authored contrast. Light-only
// product surface: single values track the canonical :root vars directly.
export const eventouchTheme = defineTheme({
  name: 'eventouch',
  extends: neutralTheme,
  // Resolve inherited touch adaptations against the product's font axes too.
  typography: {
    body: {family: 'var(--body-font)'},
    heading: {family: 'var(--body-font)'},
    code: {family: 'var(--mono-font)'},
  },
  tokens: {
    // Accent group: hover-fill accent with white on-accent keeps primary
    // text contrast; accent-muted stays neutral (no peach).
    '--color-accent': 'var(--brand-hover)',
    '--color-accent-muted': 'var(--surface-muted)',
    '--color-on-accent': 'var(--on-brand-hover)',
    '--color-text-accent': 'var(--brand-text)',
    '--color-icon-accent': 'var(--brand-text)',

    // Surfaces.
    '--color-background-surface': 'var(--paper)',
    '--color-background-card': 'var(--paper)',
    '--color-background-popover': 'var(--paper)',
    '--color-background-body': 'var(--ground)',
    '--color-background-muted': 'var(--surface-muted)',

    // Text and icons.
    '--color-text-primary': 'var(--ink)',
    '--color-text-secondary': 'var(--muted)',
    '--color-icon-primary': 'var(--ink)',
    '--color-icon-secondary': 'var(--muted)',

    // Borders.
    '--color-border': 'var(--line)',
    '--color-border-emphasized': 'var(--line-strong)',

    // Status fills, pale fills, and on-fill text.
    '--color-success': 'var(--success)',
    '--color-success-muted': 'var(--success-soft)',
    '--color-on-success': 'var(--on-brand-hover)',
    '--color-on-success-muted': 'var(--success)',
    '--color-warning': 'var(--warning)',
    '--color-warning-muted': 'var(--warning-soft)',
    '--color-on-warning': 'var(--on-brand-hover)',
    '--color-on-warning-muted': 'var(--warning)',
    '--color-error': 'var(--danger)',
    '--color-error-muted': 'var(--danger-soft)',
    '--color-on-error': 'var(--on-brand-hover)',
    '--color-on-error-muted': 'var(--danger)',
    '--color-info': 'var(--info)',
    '--color-info-muted': 'var(--info-soft)',
    '--color-on-info': 'var(--on-brand-hover)',
    '--color-on-info-muted': 'var(--info)',

    // Status text roles.
    '--color-text-success': 'var(--success)',
    '--color-icon-success': 'var(--success)',
    '--color-border-success': 'var(--success-line)',
    '--color-text-warning': 'var(--warning)',
    '--color-icon-warning': 'var(--warning)',
    '--color-border-warning': 'var(--warning-line)',
    '--color-text-error': 'var(--danger)',
    '--color-icon-error': 'var(--danger)',
    '--color-border-error': 'var(--danger-line)',
    '--color-text-info': 'var(--info)',
    '--color-icon-info': 'var(--info)',
    '--color-border-info': 'var(--info-line)',

    // Per-hue families backing the status roles, wired to the canonical
    // base/soft/line triples.
    '--color-background-red': 'var(--danger-soft)',
    '--color-border-red': 'var(--danger-line)',
    '--color-icon-red': 'var(--danger)',
    '--color-text-red': 'var(--danger)',
    '--color-background-green': 'var(--success-soft)',
    '--color-border-green': 'var(--success-line)',
    '--color-icon-green': 'var(--success)',
    '--color-text-green': 'var(--success)',
    '--color-background-yellow': 'var(--warning-soft)',
    '--color-border-yellow': 'var(--warning-line)',
    '--color-icon-yellow': 'var(--warning)',
    '--color-text-yellow': 'var(--warning)',
    '--color-background-blue': 'var(--info-soft)',
    '--color-border-blue': 'var(--info-line)',
    '--color-icon-blue': 'var(--info)',
    '--color-text-blue': 'var(--info)',

    // Fonts.
    '--font-family-body': 'var(--body-font)',
    '--font-family-heading': 'var(--body-font)',
    '--font-family-code': 'var(--mono-font)',

    // Radius.
    '--radius-element': 'var(--radius-medium)',
    '--radius-container': 'var(--radius-card)',
  },
  components: {
    button: {
      // Touch target floor; the app defines --control-min-size (44px).
      base: {minHeight: 'var(--control-min-size)'},
    },
  },
});
