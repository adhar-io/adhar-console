import { Select } from '@adhar-console/shell-ui'
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
  return (
    <label className="flex items-center gap-2 text-xs text-content-muted">
      Namespace
      <Select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="min-w-44"
      >
        <option value="">All namespaces</option>
        {namespaces.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
    </label>
  )
}
