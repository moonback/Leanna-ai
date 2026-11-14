// Test-only stand-in for '@/lib/supabase' (wired in setup.ts). Never imported by app code.
import { vi } from 'vitest';

type Session = { access_token: string; user: { id: string; email: string } };
type Listener = (event: string, session: Session | null) => void;

let current: Session | null = null;
const listeners = new Set<Listener>();

export const fakeSession = (email = 'alice@example.test'): Session => ({
  access_token: 'test-token',
  user: { id: 'user-1', email },
});

export const fakeAuth = {
  signIn(session: Session = fakeSession()) {
    current = session;
    listeners.forEach((l) => l('SIGNED_IN', session));
  },
  reset() {
    current = null;
    listeners.clear();
  },
};

export const supabase = {
  auth: {
    onAuthStateChange(cb: Listener) {
      listeners.add(cb);
      queueMicrotask(() => cb('INITIAL_SESSION', current));
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
    },
    getSession: async () => ({ data: { session: current } }),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(async () => {
      current = null;
      listeners.forEach((l) => l('SIGNED_OUT', null));
      return { error: null };
    }),
  },
};
