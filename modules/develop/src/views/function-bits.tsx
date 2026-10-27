import type { ReactNode } from 'react'
import { cn } from '@adhar/utils'

/** Small presentational pieces shared by the Functions drawer's tabs. */

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className='space-y-2'>
      <div className='flex items-center justify-between gap-2'>
        <h3 className='text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

/** A definition list; rows whose value is empty are left out rather than shown as blanks. */
export function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '')
  return (
    <dl className='grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl border border-edge-default bg-surface-raised p-4 text-[13px] sm:grid-cols-[11rem_1fr]'>
      {shown.map(([k, v]) => (
        <div key={k} className='contents'>
          <dt className='text-content-subtle'>{k}</dt>
          <dd className='min-w-0 break-words text-content [overflow-wrap:anywhere]'>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'zero'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-[12px] leading-relaxed',
        tone === 'warn'
          ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200'
          : tone === 'zero'
          ? 'border-violet-200 bg-violet-50 text-violet-900 dark:border-violet-500/25 dark:bg-violet-500/10 dark:text-violet-200'
          : 'border-edge-default bg-surface-sunken text-content-muted',
      )}
    >
      {children}
    </div>
  )
}

/** A link; one that leaves the console opens in a new tab and says so. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const external = /^https?:/.test(href)
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      className='text-brand-700 hover:underline dark:text-brand-300'
    >
      {children}
      {external ? ' ↗' : ''}
    </a>
  )
}
