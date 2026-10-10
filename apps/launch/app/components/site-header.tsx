import { Link } from '@tanstack/react-router'
import { AdharLogo } from '@adhar/shell-ui/brand'
import { ModeToggle } from '@adhar/shell-ui/mode-toggle'
import { cn } from '@adhar/utils'
import { LINKS } from '~/data/launch-content.ts'
import { IconGithub } from './icons.tsx'

/**
 * Frosted top bar: brand, GitHub, theme toggle. The maintenance page
 * passes `variant="minimal"` and also gets a way back to the site.
 */
export function SiteHeader({ variant = 'full' }: { variant?: 'full' | 'minimal' }) {
  return (
    <header
      className={cn(
        'glass sticky z-40 border-b border-edge-subtle',
        'top-[env(safe-area-inset-top,0px)]',
      )}
    >
      <div className='mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-5 sm:px-8'>
        <Link
          to='/'
          className='flex items-center rounded-md focus-visible:ring-2 focus-visible:ring-brand-500/40'
        >
          <AdharLogo symbolSize={30} subtitle='Cloud' />
        </Link>

        <div className='flex items-center gap-2'>
          <a
            href={LINKS.github}
            target='_blank'
            rel='noreferrer'
            aria-label='Adhar on GitHub'
            className='hidden size-9 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content sm:inline-flex'
          >
            <IconGithub width={18} height={18} />
          </a>
          <ModeToggle />
          {variant === 'minimal' && (
            <Link
              to='/'
              className='text-sm font-medium text-brand-700 hover:underline dark:text-brand-300'
            >
              adhar.io
            </Link>
          )}
        </div>
      </div>
    </header>
  )
}
