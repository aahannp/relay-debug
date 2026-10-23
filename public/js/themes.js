// Dark and light themes. Each sets the app colours and the terminal's 16 ANSI colours.
import { state, emit } from './ui.js';

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

// ui: background, sidebar, panel, raised panel, lines, text, muted text. Focus and selection use the terminal's blue.
// Light terminals sit on the panel colour, so a pane reads as a white sheet on a slightly darker page.
const theme = (name, dark, [bg, side, panel, panel2, line, text, dim], colors) => ({
  name, dark, ui: { bg, side, panel, panel2, line, text, dim },
  term: { background: dark ? bg : panel, foreground: text, ...Object.fromEntries(ANSI.map((key, i) => [key, colors[i]])) },
});

export const THEMES = {
  // T3 Code's neutral palette: a near-black or near-white canvas, hairline borders and one blue for focus.
  t3dark: theme('T3 Dark', true, ['#0a0a0a', '#111111', '#111111', '#181818', '#1f1f1f', '#f5f5f5', '#818181'],
    ['#262626', '#ff6467', '#00d492', '#ffb900', '#346bf1', '#ed6aff', '#00d3f2', '#d4d4d4', '#737373', '#ffa2a2', '#5ee9b5', '#ffd230', '#51a2ff', '#f4a8ff', '#53eafd', '#fafafa']),
  t3light: theme('T3 Light', false, ['#fcfcfc', '#fafafa', '#ffffff', '#fafafa', '#e4e4e7', '#27272a', '#71717b'],
    ['#27272a', '#c10007', '#007a55', '#bb4d00', '#1b4ed8', '#a800b7', '#007595', '#71717b', '#52525c', '#e7000b', '#009966', '#e17100', '#155dfc', '#c800de', '#0092b8', '#9f9fa9']),
  midnight: theme('Midnight', true, ['#0b0c10', '#08090c', '#12141a', '#1a1d26', '#252a36', '#e8eaf0', '#8b91a3'],
    ['#1c1f27', '#ff5c7a', '#4ade80', '#fbbf24', '#60a5fa', '#f472b6', '#22d3ee', '#d4d7e0', '#5b6172', '#ff8095', '#86efac', '#fcd34d', '#93c5fd', '#f9a8d4', '#67e8f9', '#ffffff']),
  tokyo: theme('Tokyo Night', true, ['#1a1b26', '#16161e', '#1f2030', '#24283b', '#2f3549', '#c0caf5', '#7a82a8'],
    ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']),
  catppuccin: theme('Catppuccin', true, ['#1e1e2e', '#181825', '#232334', '#2a2b3c', '#363a4f', '#cdd6f4', '#9399b2'],
    ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']),
  dracula: theme('Dracula', true, ['#282a36', '#21222c', '#2d2f3d', '#343746', '#44475a', '#f8f8f2', '#a0a4c0'],
    ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
  rosepine: theme('Rosé Pine', true, ['#191724', '#14121f', '#1f1d2e', '#26233a', '#2f2b45', '#e0def4', '#908caa'],
    ['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4', '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4']),
  nord: theme('Nord', true, ['#2e3440', '#292e39', '#323846', '#3b4252', '#434c5e', '#e5e9f0', '#9aa3b5'],
    ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
  gruvbox: theme('Gruvbox', true, ['#282828', '#1d2021', '#2e2c2b', '#32302f', '#45403d', '#ebdbb2', '#a89984'],
    ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
  onedark: theme('One Dark', true, ['#282c34', '#21252b', '#2c313a', '#323842', '#3e4451', '#abb2bf', '#7f8796'],
    ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
  monokai: theme('Monokai', true, ['#272822', '#1f201b', '#2d2e27', '#34352d', '#49483e', '#f8f8f2', '#a59f85'],
    ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2', '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']),
  solarized: theme('Solarized Dark', true, ['#002b36', '#00252e', '#073642', '#0a3d4a', '#174652', '#93a1a1', '#6c8288'],
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
  // Light themes. ANSI colours are each theme's own, darkened where needed so terminal text reads on its background.
  daylight: theme('Daylight', false, ['#f5f6f8', '#eceef2', '#ffffff', '#f9fafb', '#dfe2e8', '#1b1e24', '#5c6370'],
    ['#1b1e24', '#c62a4b', '#1a7f4b', '#9a6700', '#2563c9', '#b5338a', '#0e7c86', '#6b7280', '#59606c', '#a8203f', '#157a3f', '#7a5200', '#1d4fb8', '#9b2c7a', '#0a6872', '#7b828c']),
  github: theme('GitHub Light', false, ['#ffffff', '#f6f8fa', '#ffffff', '#f6f8fa', '#d1d9e0', '#1f2328', '#59636e'],
    ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#633c01', '#1e7ee6', '#9168dd', '#2e89a0', '#818993']),
  latte: theme('Catppuccin Latte', false, ['#eff1f5', '#e6e9ef', '#f9fafc', '#f3f4f8', '#ccd0da', '#4c4f69', '#5c5f77'],
    ['#5c5f77', '#d20f39', '#317b21', '#986114', '#1d62eb', '#9f508a', '#137a80', '#7c7f8a', '#6a6d82', '#de293e', '#37842e', '#9f6b1e', '#426af5', '#aa5990', '#258289', '#7b7e85']),
  dawn: theme('Rosé Pine Dawn', false, ['#faf4ed', '#f2e9e1', '#fffaf3', '#f4ede8', '#dfdad9', '#575279', '#696680'],
    ['#575279', '#a3596e', '#286983', '#966521', '#45777f', '#7b6890', '#9c5e5b', '#84808f', '#706c88', '#ad5f75', '#286983', '#a36d24', '#4b808a', '#826e99', '#a96663', '#84808f']),
  onelight: theme('One Light', false, ['#fafafa', '#eeeeef', '#ffffff', '#f3f3f4', '#dcdcde', '#383a42', '#696c77'],
    ['#383a42', '#c2493e', '#40813f', '#9b6a01', '#3a6cdb', '#a626a4', '#017aad', '#838488', '#4f525e', '#bf5c64', '#658251', '#90794d', '#467fad', '#a262b5', '#40868f', '#838383']),
  paper: theme('Solarized Light', false, ['#fdf6e3', '#f3ebd3', '#fffbf0', '#f5eedb', '#e4dcc5', '#3b5058', '#5f747b'],
    ['#073642', '#d3302d', '#687800', '#8e6c00', '#2076b3', '#c7337a', '#217e77', '#788484', '#586e75', '#cb4b16', '#586e75', '#657b83', '#6d7b7d', '#6c71c4', '#6f7979', '#002b36']),
};

const ink = hex => { // black or white text, whichever reads better on this colour
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#111' : '#fff';
};

export function applyTheme() {
  const t = THEMES[state.settings.theme] || THEMES.t3dark;
  const ring = t.term.blue;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(t.ui)) root.style.setProperty(`--${key}`, value);
  root.style.setProperty('--ring', ring);
  root.style.setProperty('--ring-ink', ink(ring));
  root.style.setProperty('--ok', t.term.green);
  root.style.setProperty('--warn', t.term.yellow);
  root.style.setProperty('--bad', t.term.red);
  root.style.setProperty('--info', t.term.blue);
  root.style.setProperty('--term-bg', t.term.background);
  root.dataset.mode = t.dark ? 'dark' : 'light';
  state.theme = t;
  state.termTheme = { ...t.term, cursor: ring, cursorAccent: t.term.background, selectionBackground: `${ring}55` };
  emit('theme');
}
