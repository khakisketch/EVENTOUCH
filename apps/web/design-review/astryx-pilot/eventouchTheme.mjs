import {defineTheme} from '@astryxdesign/core/theme';
import {neutralTheme} from '@astryxdesign/theme-neutral';

export const eventouchTheme = defineTheme({
  name: 'eventouch-pilot',
  extends: neutralTheme,
  tokens: {
    '--color-accent': '#C7441C',
    '--color-on-accent': '#FFFFFF',
    '--color-text-accent': '#8E351F',
    '--color-background-body': '#FFFFFF',
    '--color-background-surface': '#FFFFFF',
    '--font-family-body': 'Pretendard Variable, Pretendard, sans-serif',
    '--font-family-heading': 'Pretendard Variable, Pretendard, sans-serif',
    '--radius-element': '12px',
    '--radius-container': '16px',
  },
  components: {
    button: {base: {borderRadius: '12px'}},
  },
});
