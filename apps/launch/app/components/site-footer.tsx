import { Link } from '@tanstack/react-router'
import { AdharSymbol } from '@adhar/shell-ui/brand'
import { LINKS } from '~/data/launch-content.ts'

export function SiteFooter() {
  const year = new Date().getFullYear()
  return (
    <footer className='border-t border-edge-subtle'>
      <div className='mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8'>
        <div className='flex items-center gap-3 text-sm text-content-muted'>
          <AdharSymbol size={22} />
          <span>
            © {year} Adhar. Open source, self-hostable, built in the open.
          </span>
        </div>
        <nav aria-label='Footer' className='flex flex-wrap items-center gap-x-5 gap-y-2 text-sm'>
          <a
            className='text-content-muted hover:text-content'
            href={LINKS.github}
            target='_blank'
            rel='noreferrer'
          >
            GitHub
          </a>
          <a
            className='text-content-muted hover:text-content'
            href={LINKS.docs}
            target='_blank'
            rel='noreferrer'
          >
            Docs
          </a>
          <Link className='text-content-muted hover:text-content' to='/maintenance'>
            Status
          </Link>
        </nav>
      </div>
    </footer>
  )
}
