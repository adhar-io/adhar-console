import { useEffect, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { Badge, Card } from '@adhar/shell-ui/primitives'
import { cn } from '@adhar/utils'
import { LINKS, MAINTENANCE } from '~/data/launch-content.ts'
import { IconCheck, IconClock, IconWrench } from '~/components/icons.tsx'
import { InterestForm } from '~/components/interest-form.tsx'
import { MaintenanceScene } from '~/components/scene/index.tsx'
import { SiteFooter } from '~/components/site-footer.tsx'
import { SiteHeader } from '~/components/site-header.tsx'

/**
 * Maintenance page. Reads the window from `launch-content.ts` (overridable
 * per deploy with VITE_MAINT_*), and `?until=<ISO>` on the URL wins over both
 * so an operator can extend the window without a rebuild.
 */
export function MaintenancePage() {
  const { until: untilParam } = useSearch({ from: '/maintenance' })
  const until = parseDate(untilParam) ?? new Date(MAINTENANCE.until)
  const started = new Date(MAINTENANCE.startedAt)
  const remaining = useCountdown(until)
  const doneSteps = MAINTENANCE.steps.filter((s) => s.state === 'done').length
  const pct = Math.round(((doneSteps + 0.5) / MAINTENANCE.steps.length) * 100)

  return (
    <>
      <SiteHeader variant='minimal' />
      <main>
        <section className='mx-auto grid w-full max-w-6xl gap-10 px-5 pb-10 pt-12 sm:px-8 lg:grid-cols-2 lg:items-center lg:pt-16'>
          <div className='rise max-w-xl'>
            <div className='mb-5 inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-50/80 px-3 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-500/10 dark:text-amber-200'>
              <IconWrench />
              {MAINTENANCE.title}
              <span className='relative ml-1 flex size-2'>
                <span className='absolute inline-flex size-full animate-pulse-ring rounded-full bg-amber-500' />
                <span className='relative inline-flex size-2 rounded-full bg-amber-500' />
              </span>
            </div>
            <h1 className='display text-5xl font-extrabold text-content sm:text-6xl'>
              We're tightening <span className='gradient-text'>a few bolts.</span>
            </h1>
            <p className='mt-6 text-lg text-content-muted'>{MAINTENANCE.reason}</p>

            <Card elevation='float' className='mt-8 p-5'>
              <div className='flex items-center justify-between gap-4'>
                <div className='flex items-center gap-2 text-sm text-content-muted'>
                  <IconClock />
                  {remaining.past ? 'Wrapping up now' : 'Expected back in'}
                </div>
                <Badge tone='amber'>{pct}% through</Badge>
              </div>
              <p className='mt-2 text-4xl font-bold tracking-tight text-content' aria-live='polite'>
                {remaining.past ? 'Any moment' : remaining.label}
              </p>
              <dl className='mt-4 grid grid-cols-2 gap-3 border-t border-edge-subtle pt-4 text-sm'>
                <div>
                  <dt className='text-xs text-content-subtle'>Started</dt>
                  <dd className='font-medium text-content'>{fmt(started)}</dd>
                </div>
                <div>
                  <dt className='text-xs text-content-subtle'>Expected end</dt>
                  <dd className='font-medium text-content'>{fmt(until)}</dd>
                </div>
              </dl>
            </Card>

            <div className='mt-8'>
              <p className='mb-2 text-sm font-medium text-content'>Get a nudge when we're back</p>
              <InterestForm source='maintenance' compact />
            </div>
          </div>

          <div className='relative'>
            <MaintenanceScene className='relative h-[360px] sm:h-[440px] lg:h-[540px]' />
            <div
              className='hazard absolute inset-x-6 bottom-0 h-1.5 rounded-full opacity-70'
              aria-hidden
            />
          </div>
        </section>

        <section className='mx-auto grid w-full max-w-6xl gap-6 px-5 pb-24 pt-6 sm:px-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]'>
          <Card as='section' className='p-6'>
            <h2 className='text-lg font-semibold text-content'>What's happening</h2>
            <ol className='mt-5 grid gap-0'>
              {MAINTENANCE.steps.map((s, i) => (
                <li key={s.name} className='relative flex gap-4 pb-6 last:pb-0'>
                  {i < MAINTENANCE.steps.length - 1 && (
                    <span
                      className={cn(
                        'absolute left-[13px] top-7 h-[calc(100%-12px)] w-px',
                        s.state === 'done' ? 'bg-emerald-500' : 'bg-edge-default',
                      )}
                      aria-hidden
                    />
                  )}
                  <span
                    className={cn(
                      'relative mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                      s.state === 'done' && 'bg-emerald-500 text-white',
                      s.state === 'active' && 'bg-amber-500 text-white',
                      s.state === 'next' &&
                        'bg-surface-sunken text-content-subtle ring-1 ring-inset ring-edge-default',
                    )}
                  >
                    {s.state === 'done' ? <IconCheck width={14} height={14} /> : i + 1}
                    {s.state === 'active' && (
                      <span
                        className='absolute inline-flex size-full animate-pulse-ring rounded-full bg-amber-500'
                        aria-hidden
                      />
                    )}
                  </span>
                  <div>
                    <p className='font-medium text-content'>
                      {s.name}
                      {s.state === 'active' && (
                        <span className='ml-2 text-xs font-semibold text-amber-700 dark:text-amber-300'>
                          In progress
                        </span>
                      )}
                    </p>
                    <p className='text-sm text-content-muted'>{s.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          <div className='grid gap-4 content-start'>
            <Card as='section' className='p-5'>
              <h2 className='text-sm font-semibold text-content'>Temporarily unavailable</h2>
              <ul className='mt-3 grid gap-2'>
                {MAINTENANCE.affected.map((a) => (
                  <li key={a} className='flex items-center gap-2 text-sm text-content-muted'>
                    <span className='size-2 rounded-full bg-amber-500' aria-hidden />
                    {a}
                  </li>
                ))}
              </ul>
            </Card>
            <Card as='section' className='p-5'>
              <h2 className='text-sm font-semibold text-content'>Running as normal</h2>
              <ul className='mt-3 grid gap-2'>
                {MAINTENANCE.unaffected.map((a) => (
                  <li key={a} className='flex items-center gap-2 text-sm text-content-muted'>
                    <span className='size-2 rounded-full bg-emerald-500' aria-hidden />
                    {a}
                  </li>
                ))}
              </ul>
            </Card>
            <p className='px-1 text-xs text-content-subtle'>
              Your deployed applications and pipelines keep running. Only the console and sign-in
              pause while we work.{' '}
              <a
                className='font-medium text-brand-700 hover:underline dark:text-brand-300'
                href={LINKS.github}
                target='_blank'
                rel='noreferrer'
              >
                Follow along on GitHub
              </a>
              .
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  )
}

function parseDate(v: string | undefined): Date | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

function fmt(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

function useCountdown(until: Date): { label: string; past: boolean } {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = globalThis.setInterval(() => setNow(Date.now()), 30_000)
    return () => globalThis.clearInterval(id)
  }, [])
  const ms = until.getTime() - now
  if (ms <= 0) return { label: '', past: true }
  const totalMin = Math.ceil(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h >= 24) return { label: `${Math.floor(h / 24)}d ${h % 24}h`, past: false }
  if (h > 0) return { label: `${h}h ${m.toString().padStart(2, '0')}m`, past: false }
  return { label: `${m} min`, past: false }
}
