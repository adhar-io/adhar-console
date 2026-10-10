import { Link } from '@tanstack/react-router'
import { cn } from '@adhar/utils'
import { LINKS, SUPPLY_CHAIN } from '~/data/launch-content.ts'
import { activeStage, useStore } from '~/data/ui-store.ts'
import { IconGithub, IconHardHat } from '~/components/icons.tsx'
import { InterestForm } from '~/components/interest-form.tsx'
import { ToolLogo } from '~/components/tool-logos.tsx'
import { SupplyChainScene } from '~/components/scene/index.tsx'
import { SiteHeader } from '~/components/site-header.tsx'

/**
 * One screen. The supply-chain scene *is* the page: the message and the
 * early-access card sit in the upper part where the camera leaves room, the
 * conveyor runs beneath them, and the stage strip along the bottom follows
 * the lead packet through the picture. Nothing to click to register: the
 * card is right there.
 */
export function LaunchPage() {
  return (
    <>
      <SiteHeader />
      <main className='relative flex min-h-[calc(100svh-4rem)] flex-col overflow-hidden'>
        <SupplyChainScene className='absolute inset-0 h-full' />

        {
          /* Message + card. The grid itself ignores the pointer so the scene stays
            draggable between the two columns; the columns take it back. */
        }
        <div className='pointer-events-none relative z-10 mx-auto grid w-full max-w-7xl gap-8 px-5 pt-8 sm:px-8 sm:pt-10 lg:grid-cols-[minmax(0,1fr)_440px] lg:items-start lg:gap-12'>
          <div className='rise pointer-events-auto max-w-xl'>
            <div className='mb-4 inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-50/80 px-3 py-1 text-xs font-semibold text-amber-800 backdrop-blur dark:bg-amber-500/10 dark:text-amber-200'>
              <IconHardHat />
              Adhar Cloud · Launching soon
              <span className='relative ml-1 flex size-2'>
                <span className='absolute inline-flex size-full animate-pulse-ring rounded-full bg-amber-500' />
                <span className='relative inline-flex size-2 rounded-full bg-amber-500' />
              </span>
            </div>
            <h1 className='display text-4xl font-extrabold text-content sm:text-5xl lg:text-[3.4rem]'>
              Source to production. <span className='gradient-text'>One platform.</span>
            </h1>
            <p className='mt-4 max-w-lg text-base text-content-muted sm:text-lg'>
              Adhar Cloud builds, signs, promotes, deploys and observes every release on open,
              Kubernetes-native foundations. No glue code. No lock-in. Early registrations get in
              first.
            </p>
            <a
              href={LINKS.github}
              target='_blank'
              rel='noreferrer'
              className='mt-5 inline-flex items-center gap-2 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300'
            >
              <IconGithub width={16} height={16} />
              Open source, built in the open
            </a>
          </div>

          <div className='rise pointer-events-auto'>
            <InterestForm source='launch' dense />
          </div>
        </div>

        {
          /* Below `lg` the card sits under the message, so give the conveyor its
            own room before the strip instead of hiding it behind the card. */
        }
        <div className='h-[42svh] lg:hidden' aria-hidden />

        {/* Stage strip — follows the lead packet. */}
        <div className='pointer-events-none relative z-10 mt-auto pb-[max(1rem,env(safe-area-inset-bottom,0px))] pt-10'>
          <div className='mx-auto w-full max-w-7xl px-5 sm:px-8'>
            <StageStrip />
            <div className='mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-[11px] text-content-subtle'>
              <span>
                Drag to explore. One artifact follows the golden path, between the guardrails, all
                the way to production.
              </span>
              <nav aria-label='Footer' className='pointer-events-auto flex items-center gap-4'>
                <a
                  className='hover:text-content'
                  href={LINKS.github}
                  target='_blank'
                  rel='noreferrer'
                >
                  GitHub
                </a>
                <a
                  className='hover:text-content'
                  href={LINKS.docs}
                  target='_blank'
                  rel='noreferrer'
                >
                  Docs
                </a>
                <Link className='hover:text-content' to='/maintenance'>
                  Status
                </Link>
                <span>© {new Date().getFullYear()} Adhar</span>
              </nav>
            </div>
          </div>
        </div>
      </main>
    </>
  )
}

function StageStrip() {
  const active = useStore(activeStage)
  return (
    <ol
      className='pointer-events-auto grid grid-cols-3 gap-2 sm:grid-cols-6'
      aria-label='Supply chain stages'
    >
      {SUPPLY_CHAIN.map((s, i) => {
        const on = i === active
        return (
          <li
            key={s.id}
            aria-current={on ? 'step' : undefined}
            className={cn(
              'glass rounded-xl border px-3 py-2 transition-colors duration-300',
              on ? 'border-brand-500/50 shadow-md' : 'border-edge-subtle',
            )}
          >
            <div className='flex items-center gap-2'>
              <ToolLogo stage={s.id} size={24} className='shrink-0' />
              <span
                className='inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white'
                style={{ backgroundColor: s.color }}
              >
                {i + 1}
              </span>
              <span className='truncate text-xs font-semibold text-content'>{s.name}</span>
              <span className='ml-auto hidden text-[10px] font-medium text-content-subtle sm:inline'>
                {s.tool}
              </span>
            </div>
            <p
              className={cn(
                'mt-1 hidden text-[11px] leading-snug text-content-muted 2xl:block',
                !on && 'opacity-70',
              )}
            >
              {s.detail}
            </p>
          </li>
        )
      })}
    </ol>
  )
}
