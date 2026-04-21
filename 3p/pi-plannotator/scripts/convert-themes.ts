/**
 * Converts FinSitter theme CSS files into Plannotator theme format.
 *
 * FinSitter: .theme-gruvbox-dark { ... } and .theme-gruvbox-light { ... } as separate files
 * Plannotator: .theme-gruvbox { ... (dark) } and .theme-gruvbox.light { ... } in one file
 *
 * Also injects defaults for Plannotator-specific tokens (success, warning, code-bg, focus-highlight).
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const FINSITTER_DIR = '/Users/ramos/mrxtek/finsitter/reactronite/src/app/styles/themes';
const OUTPUT_DIR = join(import.meta.dir, '../packages/ui/themes');

// Themes to include, grouped by merged name
const THEME_MAP: Record<string, { dark?: string; light?: string }> = {
  'adwaita':       { dark: 'adwaita-dark.css', light: 'adwaita.css' },
  'bold-tech':     { dark: 'bold-tech-dark.css', light: 'bold-tech-light.css' },
  'caffeine':      { dark: 'caffine-dark.css', light: 'caffine-light.css' },
  'cobalt2':       { dark: 'cobalt2.css' },
  'cyberdyne':     { dark: 'cyberdyne.css' },
  'cyberfunk':     { dark: 'cyberfunk-dark.css', light: 'cyberfunk-light.css' },
  'doom-64':       { dark: 'doom-64-dark.css', light: 'doom-64-light.css' },
  'dracula':       { dark: 'dracula.css' },
  'gruvbox':       { dark: 'gruvbox-dark.css', light: 'gruvbox-light.css' },
  'ir-black':      { dark: 'ir-black.css' },
  'nord':          { dark: 'nord.css' },
  'paulmillr':     { dark: 'paulmillr.css' },
  'quantum-rose':  { dark: 'quantum-rose-dark.css', light: 'quantum-rose-light.css' },
  'solarized':     { dark: 'solarized-dark.css', light: 'solarized-light.css' },
  'solar-dusk':    { dark: 'solar-dusk-dark.css', light: 'solar-dusk-light.css' },
  'terminal':      { dark: 'terminal.css' },
  'tinacious':     { light: 'tinacious-light.css' },
};

// Plannotator-specific token defaults
const PLANNOTATOR_DEFAULTS_DARK = `
  --success: oklch(0.72 0.17 150);
  --success-foreground: oklch(0.15 0.02 260);
  --warning: oklch(0.75 0.15 85);
  --warning-foreground: oklch(0.20 0.02 260);
  --code-bg: oklch(0.13 0.015 260);
  --focus-highlight: oklch(0.70 0.20 200);`;

const PLANNOTATOR_DEFAULTS_LIGHT = `
  --success: oklch(0.45 0.20 150);
  --success-foreground: oklch(1 0 0);
  --warning: oklch(0.55 0.18 85);
  --warning-foreground: oklch(0.18 0.02 260);
  --code-bg: oklch(0.96 0.005 260);
  --focus-highlight: oklch(0.70 0.20 200);`;

function extractTokens(css: string): string {
  // Extract just the CSS variable declarations from inside the selector block
  const match = css.match(/\{([\s\S]*)\}/);
  if (!match) return '';
  return match[1].trim();
}

function hasToken(tokens: string, name: string): boolean {
  return tokens.includes(`--${name}:`);
}

function addMissingDefaults(tokens: string, defaults: string): string {
  const lines = defaults.trim().split('\n');
  const missing: string[] = [];
  for (const line of lines) {
    const match = line.match(/--([^:]+):/);
    if (match && !hasToken(tokens, match[1].trim())) {
      missing.push(line);
    }
  }
  if (missing.length === 0) return tokens;
  return tokens + '\n\n  /* Plannotator extended tokens */' + missing.join('');
}

function convertTheme(name: string, config: { dark?: string; light?: string }): string {
  const lines: string[] = [];

  if (config.dark) {
    const darkCss = readFileSync(join(FINSITTER_DIR, config.dark), 'utf-8');
    let darkTokens = extractTokens(darkCss);
    darkTokens = addMissingDefaults(darkTokens, PLANNOTATOR_DEFAULTS_DARK);
    lines.push(`.theme-${name} {`);
    lines.push(`  ${darkTokens}`);
    lines.push(`}`);
  }

  if (config.light) {
    const lightCss = readFileSync(join(FINSITTER_DIR, config.light), 'utf-8');
    let lightTokens = extractTokens(lightCss);
    lightTokens = addMissingDefaults(lightTokens, PLANNOTATOR_DEFAULTS_LIGHT);

    if (config.dark) {
      lines.push('');
      lines.push(`.theme-${name}.light {`);
    } else {
      // Light-only theme: light tokens go into .light, generate dark from light with note
      lines.push(`/* Dark mode: uses light colors as base (light-only source theme) */`);
      lines.push(`.theme-${name} {`);
      lines.push(`  ${lightTokens}`);
      lines.push(`}`);
      lines.push('');
      lines.push(`.theme-${name}.light {`);
    }
    lines.push(`  ${lightTokens}`);
    lines.push(`}`);
  } else if (config.dark) {
    // Dark-only: duplicate dark tokens for light with a note
    const darkCss = readFileSync(join(FINSITTER_DIR, config.dark), 'utf-8');
    let darkTokens = extractTokens(darkCss);
    darkTokens = addMissingDefaults(darkTokens, PLANNOTATOR_DEFAULTS_LIGHT);
    lines.push('');
    lines.push(`/* Light mode: uses dark colors as base (dark-only source theme) */`);
    lines.push(`.theme-${name}.light {`);
    lines.push(`  ${darkTokens}`);
    lines.push(`}`);
  }

  return lines.join('\n');
}

// Convert all themes
for (const [name, config] of Object.entries(THEME_MAP)) {
  const output = convertTheme(name, config);
  const outPath = join(OUTPUT_DIR, `${name}.css`);
  writeFileSync(outPath, output + '\n');
  console.log(`  Converted: ${name}.css`);
}

console.log(`\nDone! ${Object.keys(THEME_MAP).length} themes converted.`);
