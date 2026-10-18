import type { DetectedTech } from './catalog-techstack.ts'

/**
 * Versions a BOM manages for you, so a Maven/Gradle project that only names
 * `spring-boot-starter-parent 3.3.2` still says which Spring Framework line
 * and which minimum Java it builds on.
 *
 * LAST REVIEWED: 2026-10. Only release *lines* are recorded (Framework
 * `6.1.x`), never patch numbers: the exact patch depends on the Boot patch
 * and is what the running image's SBOM reports. Source: each Spring Boot
 * release's "System Requirements" page and its dependency-versions appendix.
 */

export const MANAGED_REVIEWED_AT = '2026-10'

export interface BootLine {
  /** Spring Framework line the Boot line manages. */
  framework: string
  /** Minimum Java the Boot line supports. */
  minJava: string
  /** JUnit Jupiter major the starter-test brings. */
  junit: string
}

export const SPRING_BOOT_LINES: Record<string, BootLine> = {
  '2.5': { framework: '5.3', minJava: '8', junit: '5' },
  '2.6': { framework: '5.3', minJava: '8', junit: '5' },
  '2.7': { framework: '5.3', minJava: '8', junit: '5' },
  '3.0': { framework: '6.0', minJava: '17', junit: '5' },
  '3.1': { framework: '6.0', minJava: '17', junit: '5' },
  '3.2': { framework: '6.1', minJava: '17', junit: '5' },
  '3.3': { framework: '6.1', minJava: '17', junit: '5' },
  '3.4': { framework: '6.2', minJava: '17', junit: '5' },
  '3.5': { framework: '6.2', minJava: '17', junit: '5' },
  '4.0': { framework: '7.0', minJava: '17', junit: '6' },
  '4.1': { framework: '7.0', minJava: '17', junit: '6' },
}

/** `3.3.2` → the Boot line entry, or undefined for lines outside the table. */
export function bootLine(version: string | undefined): { line: string; entry: BootLine } | undefined {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '')
  if (!m) return undefined
  const line = `${m[1]}.${m[2]}`
  const entry = SPRING_BOOT_LINES[line]
  return entry ? { line, entry } : undefined
}

/**
 * Fill in what the Spring Boot BOM manages: a Spring Framework row (the
 * line, e.g. `6.1.x`) when no file names Framework's own version, and a
 * minimum-Java note when Java has no version. Never overrides a version a
 * file states.
 */
export function withManagedVersions(tech: DetectedTech[]): DetectedTech[] {
  const boot = tech.find((t) => t.key === 'spring-boot' && t.version)
  const line = bootLine(boot?.resolved?.version ?? boot?.version)
  if (!boot || !line) return tech
  const out = [...tech]
  const detail = `managed by Spring Boot ${line.line} (BOM table, reviewed ${MANAGED_REVIEWED_AT})`
  const fw = out.findIndex((t) => t.key === 'spring')
  if (fw < 0) out.push({ key: 'spring', version: `${line.entry.framework}.x`, source: boot.source, detail, also: [], pkg: 'org.springframework:spring-core' })
  else if (!out[fw].version) out[fw] = { ...out[fw], version: `${line.entry.framework}.x`, detail }
  const java = out.findIndex((t) => t.key === 'java')
  if (java >= 0 && !out[java].version) out[java] = { ...out[java], version: `${line.entry.minJava}+`, detail: `minimum for Spring Boot ${line.line}` }
  return out
}
