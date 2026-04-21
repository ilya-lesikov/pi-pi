/**
 * Diff Type Setup Utility
 *
 * Tracks whether the user has seen the first-run diff type selection dialog.
 * Uses cookies (not localStorage) for the same reason as all other settings.
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-diff-type-setup-done';

export function needsDiffTypeSetup(): boolean {
  return storage.getItem(STORAGE_KEY) !== 'true';
}

export function markDiffTypeSetupDone(): void {
  storage.setItem(STORAGE_KEY, 'true');
}
