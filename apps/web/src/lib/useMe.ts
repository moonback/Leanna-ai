import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import { fetchMe } from './api';

export function useMe() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['me', session?.user.id],
    queryFn: ({ signal }) => fetchMe(signal),
    enabled: !!session,
  });
}
