import type { LucideIcon } from 'lucide-react';

type Props = { icon: LucideIcon; title: string; message: string; hint?: string };

export function EmptyState({ icon: Icon, title, message, hint }: Props) {
  return (
    <section className="glass flex flex-col p-5" aria-label={title}>
      <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
        <Icon className="size-4 text-cyan" aria-hidden />
        {title}
      </h2>
      <p className="mt-6 text-sm text-ink-muted">{message}</p>
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </section>
  );
}
