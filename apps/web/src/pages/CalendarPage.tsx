import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, ChevronLeft, ChevronRight, MapPin, Trash2 } from 'lucide-react';
import { createEvent, deleteEvent, fetchEvents, type CalendarEvent } from '@/lib/api';
import {
  addDays,
  dayLabel,
  fromLocalInput,
  sameDay,
  startOfWeek,
  timeLabel,
  toLocalInput,
} from '@/lib/dates';
import { Field, FormError, Input } from '@/components/Form';
import { cn } from '@/lib/utils';
import { errorMessage } from './TasksPage';

function NewEvent({ defaultDay }: { defaultDay: Date }) {
  const queryClient = useQueryClient();
  const base = new Date(defaultDay);
  base.setHours(9, 0, 0, 0);
  const [title, setTitle] = useState('');
  const [start, setStart] = useState(toLocalInput(base.toISOString()));
  const [end, setEnd] = useState(toLocalInput(new Date(base.getTime() + 3_600_000).toISOString()));
  const [allDay, setAllDay] = useState(false);
  const [location, setLocation] = useState('');
  const create = useMutation({
    mutationFn: createEvent,
    onSuccess: () => {
      setTitle('');
      setLocation('');
      return queryClient.invalidateQueries({ queryKey: ['events'] });
    },
  });
  const startsAt = fromLocalInput(start);
  const endsAt = fromLocalInput(end);
  const invalid = !startsAt || !endsAt || endsAt < startsAt;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || invalid) return;
    create.mutate({
      title: title.trim(),
      starts_at: startsAt!,
      ends_at: endsAt!,
      all_day: allDay,
      location: location.trim() || null,
    });
  }

  return (
    <form onSubmit={onSubmit} aria-label="Nouvel événement" className="glass space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="event-title" label="Titre">
          <Input
            id="event-title"
            value={title}
            maxLength={200}
            onChange={(e) => {
              setTitle(e.target.value);
              create.reset();
            }}
          />
        </Field>
        <Field id="event-location" label="Lieu (facultatif)">
          <Input
            id="event-location"
            value={location}
            maxLength={200}
            onChange={(e) => setLocation(e.target.value)}
          />
        </Field>
        <Field id="event-start" label="Début">
          <Input
            id="event-start"
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field id="event-end" label="Fin">
          <Input
            id="event-end"
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={allDay}
          onChange={(e) => setAllDay(e.target.checked)}
          className="size-4 accent-cyan"
        />
        Toute la journée
      </label>
      {invalid && start && end && (
        <p className="text-xs text-danger">La fin doit suivre le début.</p>
      )}
      <FormError message={create.error ? errorMessage(create.error) : null} />
      <button
        type="submit"
        disabled={!title.trim() || invalid || create.isPending}
        className="rounded-lg bg-gradient-to-r from-cyan to-electric px-4 py-2 text-sm font-medium text-night-950 disabled:opacity-40"
      >
        Ajouter à l’agenda
      </button>
    </form>
  );
}

function EventItem({ event }: { event: CalendarEvent }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteEvent(event.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['events'] }),
  });
  return (
    <li className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/3 px-3 py-2">
      <span className="w-24 shrink-0 text-xs text-cyan">
        {event.all_day
          ? 'Journée'
          : `${timeLabel.format(new Date(event.starts_at))} – ${timeLabel.format(new Date(event.ends_at))}`}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm break-words">{event.title}</span>
        {event.location && (
          <span className="flex items-center gap-1 text-xs text-ink-faint">
            <MapPin className="size-3" aria-hidden />
            {event.location}
          </span>
        )}
      </span>
      <button
        type="button"
        aria-label={`Supprimer « ${event.title} »`}
        onClick={() => {
          if (window.confirm(`Supprimer « ${event.title} » de l’agenda ?`)) remove.mutate();
        }}
        className="rounded-lg p-1.5 text-ink-faint hover:bg-white/5 hover:text-danger"
      >
        <Trash2 className="size-4" aria-hidden />
      </button>
    </li>
  );
}

export function CalendarPage() {
  const [week, setWeek] = useState(() => startOfWeek(new Date()));
  const end = addDays(week, 7);
  const events = useQuery({
    queryKey: ['events', week.toISOString()],
    queryFn: ({ signal }) =>
      fetchEvents({ from: week.toISOString(), to: end.toISOString() }, signal),
  });
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const today = new Date();
  // An event spanning several days is listed on each day it covers.
  const on = (day: Date) =>
    (events.data ?? []).filter(
      (e) => new Date(e.starts_at) < addDays(day, 1) && new Date(e.ends_at) >= day,
    );
  const range = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
        <Calendar className="size-6 text-cyan" aria-hidden /> Calendrier
      </h1>
      <NewEvent defaultDay={sameDay(week, startOfWeek(today)) ? today : week} />

      <section className="glass p-4" aria-label="Semaine">
        <div className="mb-3 flex items-center gap-2">
          <button
            type="button"
            aria-label="Semaine précédente"
            onClick={() => setWeek(addDays(week, -7))}
            className="rounded-lg p-2 text-ink-muted hover:bg-white/5"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <h2 className="flex-1 text-center text-sm font-medium">
            Semaine du {range.format(week)} au {range.format(addDays(week, 6))}
          </h2>
          <button
            type="button"
            aria-label="Semaine suivante"
            onClick={() => setWeek(addDays(week, 7))}
            className="rounded-lg p-2 text-ink-muted hover:bg-white/5"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setWeek(startOfWeek(new Date()))}
            className="rounded-lg border border-white/10 px-2 py-1 text-xs text-ink-muted hover:bg-white/5"
          >
            Aujourd’hui
          </button>
        </div>
        {events.isError && <FormError message={errorMessage(events.error)} />}
        <ol className="space-y-3">
          {days.map((day) => {
            const list = on(day);
            return (
              <li key={day.toISOString()} aria-label={dayLabel.format(day)}>
                <h3
                  className={cn(
                    'mb-1 text-xs capitalize',
                    sameDay(day, today) ? 'font-semibold text-cyan' : 'text-ink-muted',
                  )}
                >
                  {dayLabel.format(day)}
                </h3>
                {list.length ? (
                  <ul className="space-y-1.5">
                    {list.map((e) => (
                      <EventItem key={e.id} event={e} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-ink-faint">—</p>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
