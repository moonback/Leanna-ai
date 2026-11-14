import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FilePlus, FileText, Search, Trash2 } from 'lucide-react';
import {
  createDocument,
  deleteDocument,
  fetchDocument,
  fetchDocuments,
  updateDocument,
  type Doc,
} from '@/lib/api';
import { dateTime } from '@/lib/dates';
import { FormError, Input } from '@/components/Form';
import { errorMessage } from './TasksPage';

function DocumentList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const docs = useQuery({
    queryKey: ['documents', q],
    queryFn: ({ signal }) => fetchDocuments({ q: q || undefined }, signal),
  });
  const create = useMutation({
    mutationFn: () => createDocument({ title: 'Sans titre', content: '' }),
    onSuccess: async (doc) => {
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
      navigate(`/documents/${doc.id}`);
    },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
          <FileText className="size-6 text-cyan" aria-hidden /> Documents
        </h1>
        <button
          type="button"
          onClick={() => create.mutate()}
          disabled={create.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan to-electric px-3 py-2 text-sm font-medium text-night-950 disabled:opacity-40"
        >
          <FilePlus className="size-4" aria-hidden /> Nouveau document
        </button>
      </div>
      <FormError message={create.error ? errorMessage(create.error) : null} />

      <section className="glass p-4" aria-label="Liste des documents">
        <form
          role="search"
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(search.trim());
          }}
        >
          <label htmlFor="document-search" className="sr-only">
            Rechercher dans les documents
          </label>
          <Input
            id="document-search"
            type="search"
            value={search}
            maxLength={500}
            placeholder="Rechercher dans les documents"
            onChange={(e) => {
              setSearch(e.target.value);
              if (!e.target.value) setQ('');
            }}
          />
          <button
            type="submit"
            aria-label="Rechercher"
            className="rounded-lg border border-white/10 p-2 text-ink-muted hover:bg-white/5"
          >
            <Search className="size-4" aria-hidden />
          </button>
        </form>
        {docs.isPending && <p className="mt-3 text-sm text-ink-muted">Chargement…</p>}
        {docs.isError && <FormError message={errorMessage(docs.error)} />}
        {docs.data?.length === 0 && (
          <p className="mt-3 text-sm text-ink-muted">
            {q ? 'Aucun document ne correspond.' : 'Aucun document.'}
          </p>
        )}
        <ul className="mt-2 divide-y divide-white/5">
          {docs.data?.map((d) => (
            <li key={d.id}>
              <Link
                to={`/documents/${d.id}`}
                className="block rounded-lg px-2 py-3 hover:bg-white/5"
              >
                <span className="block text-sm">{d.title}</span>
                {/* Snippets are plain text: « » mark the matches, nothing is rendered as HTML. */}
                <span className="block truncate text-xs text-ink-faint">
                  {d.snippet ?? d.excerpt ?? ''}
                </span>
                <span className="text-[11px] text-ink-faint">
                  Modifié le {dateTime.format(new Date(d.updated_at))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function DocumentEditor({ doc }: { doc: Doc }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(doc.title);
  const [content, setContent] = useState(doc.content);
  const dirty = title !== doc.title || content !== doc.content;
  const save = useMutation({
    mutationFn: () => updateDocument(doc.id, { title: title.trim(), content }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['document', doc.id], saved);
      return queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteDocument(doc.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
      navigate('/documents');
    },
  });

  // Unsaved changes: ask before closing the tab.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  return (
    <form
      className="glass space-y-3 p-4"
      aria-label="Éditeur"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) save.mutate();
      }}
    >
      <label htmlFor="doc-title" className="sr-only">
        Titre
      </label>
      <Input
        id="doc-title"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        className="text-base font-medium"
      />
      <label htmlFor="doc-content" className="sr-only">
        Contenu
      </label>
      <textarea
        id="doc-content"
        value={content}
        maxLength={100_000}
        rows={18}
        onChange={(e) => setContent(e.target.value)}
        className="w-full resize-y rounded-lg border border-white/10 bg-night-950/60 px-3 py-2 font-mono text-sm leading-relaxed text-ink focus:border-cyan/60 focus:outline-none"
      />
      <FormError
        message={save.error || remove.error ? errorMessage(save.error ?? remove.error) : null}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!dirty || !title.trim() || save.isPending}
          className="rounded-lg bg-gradient-to-r from-cyan to-electric px-4 py-2 text-sm font-medium text-night-950 disabled:opacity-40"
        >
          Enregistrer
        </button>
        <span role="status" className="text-xs text-ink-faint">
          {dirty ? 'Modifications non enregistrées' : 'Enregistré'} · {content.length} caractères
        </span>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Supprimer définitivement « ${doc.title} » ?`)) remove.mutate();
          }}
          className="ml-auto flex items-center gap-1 text-sm text-danger hover:underline"
        >
          <Trash2 className="size-4" aria-hidden /> Supprimer
        </button>
      </div>
    </form>
  );
}

function DocumentView({ id }: { id: string }) {
  const doc = useQuery({
    queryKey: ['document', id],
    queryFn: ({ signal }) => fetchDocument(id, signal),
  });
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link
        to="/documents"
        className="inline-flex items-center gap-2 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden /> Documents
      </Link>
      {doc.isPending && <p className="text-sm text-ink-muted">Chargement…</p>}
      {doc.isError && <FormError message={errorMessage(doc.error)} />}
      {doc.data && <DocumentEditor key={doc.data.id} doc={doc.data} />}
    </div>
  );
}

export function DocumentsPage() {
  const { id } = useParams();
  return id ? <DocumentView id={id} /> : <DocumentList />;
}
