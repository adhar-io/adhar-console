/**
 * The YAML reader moved to `@adhar-console/utils`.
 *
 * It was server-only while the only things reading YAML were the template
 * discovery and the scaffolder. The platform module's provisioning dialog now
 * needs it too — its YAML pane became editable, so something has to read the
 * manifest back — and a module cannot import from `apps/`. One implementation
 * in a package beats a second copy that drifts.
 *
 * This file stays so the existing server imports keep working.
 */
export { parseYaml, type YamlValue } from '@adhar-console/utils'
