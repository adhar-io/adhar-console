import { Select } from '@adhar/shell-ui'
import { useNamespaces } from '../data/hooks.ts'

interface Props {
  value?: string
  onChange(ns?: string): void
}

/**
 * Namespace dropdown populated from the live cluster. Falls back to an
 * empty "All namespaces" option while loading or if the user lacks
 * `namespaces:list` rights.
 */
export function NamespacePicker({ value, onChange }: Props) {
  const q = useNamespaces()
  const namespaces = (q.data ?? [])
    .map((n) => n.metadata.name)
    .filter(Boolean)
    .sort()
  // The caller frames it (cloud shell wraps it in a labelled Field), so the
  // picker carries only an accessible name — an inline "Namespace" label here
  // printed the word twice and squeezed the select on a phone.
  return (
    <Select
      aria-label="Namespace"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="w-full"
    >
      <option value="">All namespaces</option>
      {namespaces.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </Select>
  )
}
