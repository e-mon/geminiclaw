/**
 * tui/pi/theme.ts — Color palette inspired by OpenClaw's design language.
 *
 * Applies chalk's bgHex for card backgrounds and hex colors for text.
 */

import chalk from 'chalk';

// Background color functions for tool cards
export const toolPendingBg = (s: string): string => chalk.bgHex('#1F2A2F')(s);
export const toolSuccessBg = (s: string): string => chalk.bgHex('#1E2D23')(s);
export const toolErrorBg = (s: string): string => chalk.bgHex('#2F1F1F')(s);

// User message background
export const userMsgBg = (s: string): string => chalk.bgHex('#2B2F36')(s);

// Text colors
export const toolTitle = chalk.hex('#F6C453');
export const accent = chalk.hex('#F6C453');
export const borderDim = chalk.hex('#3C414B');
export const assistText = chalk.hex('#F3EEE0');
export const userText = chalk.hex('#F3EEE0');
export const mutedText = chalk.hex('#8B9199');
