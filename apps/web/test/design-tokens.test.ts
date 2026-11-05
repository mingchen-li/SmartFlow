import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const tokens = read('../src/styles/tokens.css');
const components = read('../src/styles/app.css');

const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g;

describe('Matwings Venus Light token discipline', () => {
  it('keeps every raw color value in tokens.css', () => {
    expect(components.match(RAW_COLOR)).toBeNull();
  });

  it('defines the brand, surface, semantic, and focus tokens components consume', () => {
    for (const token of [
      '--color-brand-primary: #3572ff',
      '--color-brand-primary-hover: #5990ff',
      '--color-brand-primary-active: #2150d2',
      '--color-brand-primary-bg: #f5f9ff',
      '--color-brand-primary-border: #a0c6ff',
      '--color-text-primary: #242428',
      '--color-text-secondary: #8a8a97',
      '--color-surface-white: #ffffff',
      '--color-surface-gray-50: #f6f6f7',
      '--color-semantic-success: #12b76a',
      '--color-semantic-warning: #f59e0b',
      '--color-semantic-destructive: #e7000b',
      '--color-status-success-bg: #e8f8f0',
      '--color-status-warning-bg: #fff4d6',
      '--color-status-destructive-bg: #ffe8e9',
      '--color-ring: rgb(53 114 255 / 36%)',
      '--color-destructive-ring: rgb(231 0 11 / 20%)',
    ]) {
      expect(tokens.toLowerCase()).toContain(token.toLowerCase());
    }
  });

  it('declares token-driven Button, Input, Tabs, Nav, Card, Badge, and Progress states', () => {
    expect(components).toContain('.button-primary');
    expect(components).toContain('.button-primary:hover');
    expect(components).toContain('.button-primary:active');
    expect(components).toContain('.button:disabled');
    expect(components).toContain('.input:focus');
    expect(components).toContain('.input[aria-invalid="true"]');
    expect(components).toContain('.tab[aria-selected="true"]');
    expect(components).toContain('.nav-item[aria-current="page"]');
    expect(components).toContain('.card');
    expect(components).toContain('.badge-info');
    expect(components).toContain('.badge-success');
    expect(components).toContain('.badge-warning');
    expect(components).toContain('.badge-destructive');
    expect(components).toContain('.badge-neutral');
    expect(components).toContain('.progress');
    expect(components).toContain('.progress-fill');
  });

  it('uses the semantic status tokens for error and Progress states', () => {
    const errorInput = components.slice(
      components.indexOf('.input[aria-invalid="true"]'),
      components.indexOf('.input[aria-invalid="true"]') + 400,
    );
    expect(errorInput).toContain('var(--color-semantic-destructive)');
    expect(errorInput).toContain('var(--color-destructive-ring)');

    const progress = components.slice(
      components.indexOf('.progress'),
      components.indexOf('.progress') + 700,
    );
    expect(progress).toContain('var(--color-brand-primary-bg)');
    expect(progress).toContain('var(--color-brand-primary)');
    expect(progress).toContain('var(--color-text-secondary)');
  });
});
