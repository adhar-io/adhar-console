import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import type { plane } from '@adhar-console/api-clients'
import {
  memberDisplayName,
  memberInitials,
  useCreatePage,
  useDeletePage,
  useMembers,
  usePages,
  useUpdatePage,
} from '../data/plane.ts'

/**
 * Pages — Plane wiki with full CRUD.
 *
 *   Left  : page list with new-page button, favourites star, public/private
 *           badge, last-updated timestamp.
 *   Right : preview / editor — toggle between read mode (renders the
 *           page's `description_html`) and edit mode (textarea + access toggle
 *           + save / delete actions).
 */
export function Pages({ projectId }: { projectId?: string }) {
  const q = usePages(projectId)
  const members = useMembers()
  const createPage = useCreatePage(projectId)
  const [selected, setSelected] = useState<string | null>(null)

  if (!projectId) return <EmptyState title="Pick a project" />
  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading pages…
      </div>
    )
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Couldn't reach Plane"
        description={q.error instanceof Error ? q.error.message : 'Unknown error.'}
      />
    )
  }
  const pages = q.data ?? []
  const activeId = selected ?? pages[0]?.id
  const activePage = pages.find((p) => p.id === activeId)
  const memberMap = new Map((members.data ?? []).map((m) => [m.member?.id ?? m.id, m]))

  const onCreate = () => {
    createPage.mutate(
      { name: 'Untitled page', description_html: '<p></p>', access: 'public' } as Partial<plane.Page>,
      { onSuccess: (p) => setSelected(p.id) },
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-content">All pages</span>
            <Button size="xs" onClick={onCreate} loading={createPage.isPending}>
              + New
            </Button>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {pages.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-content-muted">
              No pages yet — click <strong className="text-content">+ New</strong>.
            </div>
          ) : (
            <ul className="divide-y divide-edge-subtle">
              {pages.map((p) => {
                const on = p.id === activePage?.id
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(p.id)}
                      className={cn(
                        'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                        on ? 'bg-brand-50/60' : 'hover:bg-surface-sunken',
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'mt-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-[11px]',
                          on
                            ? 'bg-brand-100 text-brand-700'
                            : 'bg-surface-sunken text-content-muted',
                        )}
                      >
                        {p.is_favorite ? '★' : <IconDoc />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <span
                            className={cn(
                              'truncate text-sm leading-snug',
                              on ? 'font-semibold text-content' : 'font-medium text-content',
                            )}
                          >
                            {p.name}
                          </span>
                          <StatusBadge
                            kind={p.access === 'public' ? 'info' : 'unknown'}
                            dot={false}
                          >
                            {p.access}
                          </StatusBadge>
                        </div>
                        <div className="mt-0.5 line-clamp-2 text-[11px] text-content-muted">
                          {p.description_stripped ?? '—'}
                        </div>
                        <div className="mt-1 text-[10px] text-content-subtle">
                          Updated {formatRelative(p.updated_at ?? p.created_at)}
                        </div>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {activePage ? (
        <PagePreview
          key={activePage.id}
          projectId={projectId}
          page={activePage}
          owner={memberMap.get(activePage.owned_by)}
          onDeleted={() => setSelected(null)}
        />
      ) : (
        <Card>
          <CardBody className="p-10 text-center text-sm text-content-muted">
            Pick a page on the left or create a new one.
          </CardBody>
        </Card>
      )}
    </div>
  )
}

function PagePreview({
  projectId,
  page,
  owner,
  onDeleted,
}: {
  projectId: string
  page: plane.Page
  owner?: plane.Member
  onDeleted(): void
}) {
  const update = useUpdatePage(projectId)
  const remove = useDeletePage(projectId)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(page.name)
  const [body, setBody] = useState(page.description_html ?? page.description_stripped ?? '')
  const [access, setAccess] = useState<plane.Page['access']>(page.access)
  const [favorite, setFavorite] = useState(!!page.is_favorite)

  // Reset draft state when the active page changes.
  useEffect(() => {
    setName(page.name)
    setBody(page.description_html ?? page.description_stripped ?? '')
    setAccess(page.access)
    setFavorite(!!page.is_favorite)
  }, [page.id])

  const save = () => {
    update.mutate(
      {
        id: page.id,
        patch: {
          name,
          description_html: body,
          access,
          is_favorite: favorite,
        },
      },
      { onSuccess: () => setEditing(false) },
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editing ? (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-edge-default bg-white px-2 py-1 text-lg font-semibold tracking-tight text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
              />
            ) : (
              <h2 className="truncate text-lg font-semibold tracking-tight text-content">
                {page.name}
              </h2>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-content-muted">
              {owner ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-200">
                    {memberInitials(owner)}
                  </span>
                  {memberDisplayName(owner)}
                </span>
              ) : null}
              <span className="text-content-subtle">·</span>
              <span>Updated {formatRelative(page.updated_at ?? page.created_at)}</span>
              {favorite ? <StatusBadge kind="paused">favorite</StatusBadge> : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {editing ? (
              <>
                <select
                  value={access}
                  onChange={(e) => setAccess(e.target.value as plane.Page['access'])}
                  className="h-8 rounded-md border border-edge-default bg-white px-2 text-xs"
                >
                  <option value="public">public</option>
                  <option value="private">private</option>
                </select>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setFavorite((f) => !f)}
                  leading={<span aria-hidden>{favorite ? '★' : '☆'}</span>}
                >
                  {favorite ? 'Unstar' : 'Star'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={save} loading={update.isPending}>
                  Save
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    if (!confirm(`Delete "${page.name}"? This can't be undone.`)) return
                    remove.mutate(page.id, { onSuccess: () => onDeleted() })
                  }}
                  loading={remove.isPending}
                >
                  Delete
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardBody>
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={20}
              spellCheck={false}
              placeholder="Write something… HTML or Markdown-flavoured plain text."
              className="block w-full resize-y rounded-lg border border-edge-default bg-white px-3 py-2 font-mono text-xs text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
            <div className="flex items-center justify-between text-[11px] text-content-subtle">
              <span>Plane stores HTML — paste rich text or write prose.</span>
              <span>{body.length.toLocaleString()} chars</span>
            </div>
          </div>
        ) : (
          <article
            className="prose prose-sm max-w-none text-content"
            dangerouslySetInnerHTML={{
              __html:
                page.description_html ||
                `<p>${escapeHtml(page.description_stripped ?? 'This page is empty — click Edit to start writing.')}</p>`,
            }}
          />
        )}
      </CardBody>
    </Card>
  )
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function IconDoc() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  )
}
