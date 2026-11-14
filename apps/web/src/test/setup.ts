import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { fakeAuth } from './fakeSupabase';

vi.mock('@/lib/supabase', () => import('./fakeSupabase'));

afterEach(() => {
  cleanup();
  fakeAuth.reset();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
