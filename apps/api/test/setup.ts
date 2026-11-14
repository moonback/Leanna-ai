// Integration tests talk to the local Supabase stack configured in apps/api/.env.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env: tests needing Supabase fail with an explicit env validation error.
}
