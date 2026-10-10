import { type FormEvent, useId, useState } from 'react'
import { Button } from '@adhar/shell-ui/button'
import { Card } from '@adhar/shell-ui/primitives'
import { useToast } from '@adhar/shell-ui/toast'
import { cn } from '@adhar/utils'
import {
  type InterestInput,
  type InterestSource,
  submitInterest,
  type ValidationError,
} from '~/data/interest.ts'
import { IconArrowRight, IconCheck, IconSparkles } from './icons.tsx'

const FIELD =
  'w-full rounded-md border border-edge-default bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle ' +
  'focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 focus:outline-none ' +
  'aria-[invalid=true]:border-rose-500 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-rose-500/25'

interface Props {
  source: InterestSource
  /**
   * `compact` is the maintenance-page form: email only, one row, no card.
   * The full form asks for enough to prioritise invitations.
   */
  compact?: boolean
  /** Tighter spacing + frosted surface, for the card that floats over the scene. */
  dense?: boolean
  className?: string
}

/**
 * Early-access registration.
 *
 * Validation runs client-side with the same function the server uses, so
 * errors appear inline before a request is made. Outcomes surface as toasts
 * (success / error / retry), per the console's feedback convention, and the
 * success state replaces the form so the position in line is unmissable.
 */
export function InterestForm({ source, compact = false, dense = false, className }: Props) {
  const toast = useToast()
  const uid = useId()
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<keyof InterestInput, string>>>({})
  const [done, setDone] = useState<{ position: number; already: boolean } | null>(null)
  const [draft, setDraft] = useState<InterestInput>({
    email: '',
    name: '',
    company: '',
    building: '',
    source,
    website: '',
  })

  const set = (k: keyof InterestInput) => (e: { target: { value: string } }) => {
    setDraft((d) => ({ ...d, [k]: e.target.value }))
    if (errors[k]) setErrors((er) => ({ ...er, [k]: undefined }))
  }

  function applyErrors(list: ValidationError[] | undefined) {
    const next: typeof errors = {}
    for (const e of list ?? []) next[e.field] = e.message
    setErrors(next)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    const result = await submitInterest(draft)
    setBusy(false)

    if (result.ok) {
      setDone({ position: result.position, already: result.alreadyRegistered })
      toast.success(
        result.alreadyRegistered ? 'You were already on the list.' : 'You are on the list.',
        { description: `Position #${result.position}. We will write to ${draft.email} first.` },
      )
      return
    }
    if (result.reason === 'invalid') {
      applyErrors(result.errors)
      const first = result.errors?.[0]
      if (first && first.field !== 'website') {
        toast.warning(first.message)
        document.getElementById(`${uid}-${first.field}`)?.focus()
      }
      return
    }
    toast.error(
      result.reason === 'offline'
        ? 'Could not reach the registration service.'
        : 'Something went wrong on our side.',
      {
        description: 'Your details are still in the form — try again in a moment.',
        action: { label: 'Retry', onClick: () => void onSubmit(e) },
      },
    )
  }

  if (done) {
    return (
      <div
        role='status'
        className={cn(
          'flex items-start gap-4 rounded-xl border border-emerald-500/30 bg-emerald-50 p-5 dark:bg-emerald-500/10',
          className,
        )}
      >
        <span className='mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white'>
          <IconCheck width={18} height={18} />
        </span>
        <div>
          <p className='text-base font-semibold text-content'>
            {done.already ? 'You are already in line' : 'You are in line'} — #{done.position}
          </p>
          <p className='mt-1 text-sm text-content-muted'>
            We will send invitations in order, starting with the people on this list. Keep an eye on
            {' '}
            <span className='font-medium text-content'>{draft.email}</span>.
          </p>
        </div>
      </div>
    )
  }

  const emailField = (
    <div className={compact ? 'flex-1' : undefined}>
      <label
        htmlFor={`${uid}-email`}
        className={cn('mb-1.5 block text-xs font-medium text-content-muted', compact && 'sr-only')}
      >
        Work email <span className='text-rose-500'>*</span>
      </label>
      <input
        id={`${uid}-email`}
        type='email'
        name='email'
        autoComplete='email'
        inputMode='email'
        required
        placeholder='you@company.com'
        value={draft.email}
        onChange={set('email')}
        aria-invalid={errors.email ? true : undefined}
        aria-describedby={errors.email ? `${uid}-email-err` : undefined}
        className={cn(FIELD, compact ? 'h-11' : 'h-10')}
      />
      {errors.email && (
        <p id={`${uid}-email-err`} className='mt-1 text-xs text-rose-600 dark:text-rose-400'>
          {errors.email}
        </p>
      )}
    </div>
  )

  // Honeypot: visually and semantically hidden, never autofilled by browsers.
  const honeypot = (
    <div className='absolute -left-[9999px] top-auto h-px w-px overflow-hidden' aria-hidden>
      <label htmlFor={`${uid}-website`}>Website</label>
      <input
        id={`${uid}-website`}
        type='text'
        tabIndex={-1}
        autoComplete='off'
        value={draft.website}
        onChange={set('website')}
      />
    </div>
  )

  if (compact) {
    return (
      <form
        onSubmit={onSubmit}
        noValidate
        className={cn('relative flex flex-col gap-2 sm:flex-row sm:items-start', className)}
      >
        {honeypot}
        {emailField}
        <Button type='submit' variant='primary' size='lg' loading={busy} className='sm:h-11'>
          Notify me
          <IconArrowRight />
        </Button>
      </form>
    )
  }

  return (
    <Card
      elevation='float'
      className={cn('relative', dense ? 'glass p-5' : 'p-6 sm:p-7', className)}
    >
      <div
        className={cn(
          'flex items-center gap-2 text-brand-700 dark:text-brand-300',
          dense ? 'mb-3' : 'mb-5',
        )}
      >
        <IconSparkles />
        <span className='text-xs font-semibold uppercase tracking-[0.16em]'>Early access</span>
        {dense && (
          <span className='ml-auto text-[11px] font-medium normal-case tracking-normal text-content-subtle'>
            First in, first invited
          </span>
        )}
      </div>
      <form onSubmit={onSubmit} noValidate className={cn('grid', dense ? 'gap-3' : 'gap-4')}>
        {honeypot}
        {emailField}
        <div className={cn('grid sm:grid-cols-2', dense ? 'gap-3' : 'gap-4')}>
          <div>
            <label
              htmlFor={`${uid}-name`}
              className='mb-1.5 block text-xs font-medium text-content-muted'
            >
              Name
            </label>
            <input
              id={`${uid}-name`}
              type='text'
              name='name'
              autoComplete='name'
              placeholder='Ada Lovelace'
              value={draft.name}
              onChange={set('name')}
              className={cn(FIELD, 'h-10')}
            />
          </div>
          <div>
            <label
              htmlFor={`${uid}-company`}
              className='mb-1.5 block text-xs font-medium text-content-muted'
            >
              Company
            </label>
            <input
              id={`${uid}-company`}
              type='text'
              name='organization'
              autoComplete='organization'
              placeholder='Analytical Engines Ltd'
              value={draft.company}
              onChange={set('company')}
              className={cn(FIELD, 'h-10')}
            />
          </div>
        </div>
        <div>
          <label
            htmlFor={`${uid}-building`}
            className='mb-1.5 block text-xs font-medium text-content-muted'
          >
            What would you move onto Adhar Cloud first?{' '}
            <span className='font-normal text-content-subtle'>(optional)</span>
          </label>
          <textarea
            id={`${uid}-building`}
            name='building'
            rows={dense ? 2 : 3}
            maxLength={600}
            placeholder='A handful of services and their pipelines, to start…'
            value={draft.building}
            onChange={set('building')}
            className={cn(FIELD, 'resize-y py-2')}
          />
        </div>
        <div className='flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between'>
          <p className='text-xs text-content-subtle'>
            No newsletter. One email when your invitation is ready.
          </p>
          <Button type='submit' variant='primary' size='lg' loading={busy} className='sm:shrink-0'>
            Get early access
            <IconArrowRight />
          </Button>
        </div>
      </form>
    </Card>
  )
}
