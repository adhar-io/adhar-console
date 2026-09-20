/**
 * Re-export barrel so the Overview's tile panel and radar panel provably read
 * the same DORA sources.
 *
 * They diverged before — the radar scored lead time from PR cycle time and
 * change-fail rate from a point-in-time sync snapshot while the tiles used
 * commit→deploy and incident correlation — and two panels on one page
 * disagreeing about the same week is worse than either being imperfect.
 */
export { appWorkloads } from './platform-signals.ts'
export {
  changeFailureRate,
  type ChangeFailureSummary,
  type DeployEvent,
  formatDuration,
  formatRate,
  mttrSummary,
  type MttrSummary,
} from './dora-incidents.ts'
