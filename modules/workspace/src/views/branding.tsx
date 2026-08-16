import { useEffect, useMemo, useState } from 'react'
import { formatRelative } from '@adhar-console/utils'
import {
  LOCALES,
  TIMEZONES,
  useGeneralSettings,
  useSaveGeneralSettings,
  isValidEmail,
  isValidHttpUrl,
  type GeneralSettingsDoc,
} from '../data/preferences.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  SettingsRow,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { LoadingBlock, StoreErrorBlock } from '../components/async-states.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

/**
 * Branding & locale — extends the Organization → General basics (name, slug,
 * domain, SSO) into presentation and regional preferences: logo, brand color,
 * contact links, timezone, and locale. Singleton `workspace.general` doc.
 */
export function BrandingLocale() {
  const q = useGeneralSettings()

  if (q.isError) {
    return (
      <Shell>
        <StoreErrorBlock error={q.error as Error} onRetry={() => q.refetch()} />
      </Shell>
    )
  }
  if (q.isLoading || !q.data) {
    return (
      <Shell>
        <LoadingBlock label="Loading branding & locale…" />
      </Shell>
    )
  }

  const { doc, saved, updatedAt } = q.data
  return (
    <Shell>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Brand color"
          value={
            <span className="inline-flex items-center gap-2">
              <span
                className="inline-block h-4 w-4 rounded-full border border-edge-default"
                style={{ backgroundColor: doc.branding.brandColor }}
                aria-hidden
              />
              <span className="font-mono text-sm">{doc.branding.brandColor}</span>
            </span>
          }
        />
        <StatTile label="Timezone" value={doc.locale.timezone} hint="org default" />
        <StatTile label="Locale" value={doc.locale.locale} hint="dates & numbers" />
        <StatTile
          label="Settings"
          value={saved ? 'Saved' : 'Defaults'}
          tone={saved ? 'good' : 'default'}
          hint={saved && updatedAt ? `updated ${formatRelative(updatedAt)}` : 'not saved yet'}
        />
      </div>

      {!saved ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Showing platform defaults — this tenant has not saved branding & locale settings yet.
        </p>
      ) : null}

      <RequirePermission perm="org.write" required={['admin', 'owner']} readOnly>
        <Editor doc={doc} />
      </RequirePermission>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ViewShell
      title="Branding & locale"
      description="How the organization presents itself — logo, brand color, contact links — plus the timezone and locale used for org-level schedules, reports, and emails. Console colors live under Appearance → Theming."
      required={['admin', 'owner']}
    >
      {children}
    </ViewShell>
  )
}

function Editor({ doc }: { doc: GeneralSettingsDoc }) {
  const save = useSaveGeneralSettings()
  const [branding, setBranding] = useState(doc.branding)
  const [contact, setContact] = useState(doc.contact)
  const [locale, setLocale] = useState(doc.locale)
  const [logoBroken, setLogoBroken] = useState(false)

  useEffect(() => {
    setBranding(doc.branding)
    setContact(doc.contact)
    setLocale(doc.locale)
  }, [doc])

  useEffect(() => {
    setLogoBroken(false)
  }, [branding.logoUrl])

  const dirty =
    JSON.stringify({ branding, contact, locale }) !==
    JSON.stringify({ branding: doc.branding, contact: doc.contact, locale: doc.locale })

  const emailInvalid = contact.supportEmail !== '' && !isValidEmail(contact.supportEmail)
  const homepageInvalid = contact.homepageUrl !== '' && !isValidHttpUrl(contact.homepageUrl)
  const logoInvalid = branding.logoUrl !== '' && !isValidHttpUrl(branding.logoUrl)
  const colorInvalid = !/^#[0-9a-fA-F]{6}$/.test(branding.brandColor)
  const invalid = emailInvalid || homepageInvalid || logoInvalid || colorInvalid

  const nowInTz = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(locale.locale, {
        timeZone: locale.timezone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date())
    } catch {
      return null
    }
  }, [locale])

  const saveBar = (
    <div className="flex items-center gap-2">
      <SecondaryButton
        disabled={!dirty || save.isPending}
        onClick={() => {
          setBranding(doc.branding)
          setContact(doc.contact)
          setLocale(doc.locale)
        }}
      >
        Reset
      </SecondaryButton>
      <PrimaryButton
        disabled={!dirty || invalid || save.isPending}
        onClick={() => save.mutate({ branding, contact, locale })}
      >
        {save.isPending ? 'Saving…' : 'Save changes'}
      </PrimaryButton>
    </div>
  )

  return (
    <>
      <SettingsCard
        title="Brand"
        description="Shown on invites, notification emails, and the org switcher."
        actions={saveBar}
      >
        <SettingsRow
          label="Logo URL"
          description="Externally hosted square image (SVG or PNG, ≥ 128px). The preview loads it live from your host."
        >
          <div className="space-y-2">
            <TextField
              type="url"
              mono
              value={branding.logoUrl}
              onChange={(v) => setBranding((b) => ({ ...b, logoUrl: v }))}
              placeholder="https://acme.com/logo.svg"
            />
            {logoInvalid ? (
              <p className="text-[11px] text-rose-700 dark:text-rose-400">Enter an http(s) URL.</p>
            ) : null}
            {branding.logoUrl && !logoInvalid ? (
              logoBroken ? (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  The image could not be loaded from this browser.
                </p>
              ) : (
                <img
                  src={branding.logoUrl}
                  alt="Organization logo preview"
                  onError={() => setLogoBroken(true)}
                  className="h-12 w-12 rounded-lg border border-edge-default bg-surface-sunken object-contain p-1"
                />
              )
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow
          label="Brand color"
          description="Accent for the org avatar when no logo is set. Does not change the console theme."
        >
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={colorInvalid ? '#7c3aed' : branding.brandColor}
              onChange={(e) => setBranding((b) => ({ ...b, brandColor: e.target.value }))}
              aria-label="Brand color"
              className="h-9 w-10 cursor-pointer rounded-lg border border-edge-default bg-surface-raised p-1"
            />
            <TextField
              mono
              value={branding.brandColor}
              onChange={(v) => setBranding((b) => ({ ...b, brandColor: v }))}
              placeholder="#7c3aed"
            />
          </div>
          {colorInvalid ? (
            <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">
              Use a 6-digit hex color, e.g. #7c3aed.
            </p>
          ) : null}
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Contact"
        description="Where members and the platform point people for help."
      >
        <SettingsRow
          label="Support email"
          description="Linked from error pages and lifecycle emails sent to members."
        >
          <TextField
            type="email"
            value={contact.supportEmail}
            onChange={(v) => setContact((c) => ({ ...c, supportEmail: v }))}
            placeholder="support@acme.com"
          />
          {emailInvalid ? (
            <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">
              Enter a valid email address.
            </p>
          ) : null}
        </SettingsRow>
        <SettingsRow label="Homepage URL" description="Linked from the org avatar and invites.">
          <TextField
            type="url"
            mono
            value={contact.homepageUrl}
            onChange={(v) => setContact((c) => ({ ...c, homepageUrl: v }))}
            placeholder="https://acme.com"
          />
          {homepageInvalid ? (
            <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">
              Enter an http(s) URL.
            </p>
          ) : null}
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Timezone & locale"
        description="Org-level defaults for schedules, digests, and exports. Members' personal preferences win inside their own session."
      >
        <SettingsRow
          label="Default timezone"
          description="IANA timezone list provided by this browser's ICU data."
          hint={nowInTz ? `Now in ${locale.timezone}: ${nowInTz}` : undefined}
        >
          <SelectField
            value={locale.timezone}
            onChange={(v) => setLocale((l) => ({ ...l, timezone: v }))}
            options={TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
          />
        </SettingsRow>
        <SettingsRow label="Default locale" description="Formatting for dates and numbers.">
          <SelectField
            value={locale.locale}
            onChange={(v) => setLocale((l) => ({ ...l, locale: v }))}
            options={LOCALES}
          />
        </SettingsRow>
      </SettingsCard>

      {save.isError ? (
        <p className="text-[12px] text-rose-700 dark:text-rose-400">
          {(save.error as Error)?.message ?? 'Could not save branding & locale.'}
        </p>
      ) : null}
      {save.isSuccess && !dirty ? (
        <p className="text-[12px] text-emerald-700 dark:text-emerald-400">Changes saved.</p>
      ) : null}
    </>
  )
}

export default BrandingLocale
