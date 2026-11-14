import { Activity, Calendar, CheckSquare, Rocket } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { useMe } from '@/lib/useMe';

// No data source exists yet: every panel shows a real empty state, never placeholder data.
export function DashboardPage() {
  const name = useMe().data?.profile.display_name;
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <section className="glass relative overflow-hidden p-6 md:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-violet/20 blur-3xl"
        />
        <p className="text-xs uppercase tracking-[0.2em] text-cyan">Tableau de bord</p>
        <h1 className="mt-2 font-display text-2xl font-semibold md:text-3xl">
          {name ? `Bonjour, ${name}` : 'Bienvenue sur LEANA'}
        </h1>
        <p className="mt-2 max-w-xl text-sm text-ink-muted">
          Votre assistant opérationnel : il comprend, planifie, demande votre accord, exécute et
          vérifie. Les modules s’activent au fil de leur mise en service.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <EmptyState
          icon={Rocket}
          title="Missions en cours"
          message="Aucune mission pour l’instant."
          hint="Le Mission Engine arrive en phase 5."
        />
        <EmptyState
          icon={CheckSquare}
          title="Tâches prioritaires"
          message="Aucune tâche."
          hint="Le gestionnaire de tâches arrive en phase 7."
        />
        <EmptyState
          icon={Calendar}
          title="Agenda"
          message="Aucun événement à venir."
          hint="Le calendrier arrive en phase 7."
        />
        <EmptyState
          icon={Activity}
          title="Activité récente"
          message="Aucune activité enregistrée."
          hint="Le journal d’activité arrive en phase 5."
        />
      </div>
    </div>
  );
}
