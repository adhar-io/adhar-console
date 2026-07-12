# Phase · Discover

Observability — logs, metrics, traces, curated dashboards.

- **Primary backers:** Grafana, Loki, Mimir, Tempo, Prometheus,
  OpenTelemetry Collector, Beyla.
- **Module:** `modules/discover` → exposes `./Home`, `./Logs`, `./Metrics`,
  `./Traces`, `./Dashboards`.
- **Port in dev:** 5105.

See [architecture/observability.md](../architecture/observability.md) for the
full data-plane picture; this page is about what each tab does in the UI.

## Views

### Dashboards

Left pane lists curated dashboards by UID; right pane embeds Grafana in
`kiosk=tv` mode with the user's session propagated. Five starter
dashboards ship — extend by editing `modules/discover/src/views/dashboards.tsx`
or by provisioning new ones to Grafana.

### Logs

LogQL query box with results rendered inline as a dark terminal. Default
query is broad; users refine with stream selectors. Log level is extracted
from structured log JSON — falls back to "info" when absent.

### Metrics

PromQL query box with results rendered as multi-series cards, each with a
Sparkline (`modules/discover/src/views/sparkline.tsx`). Good enough for
ad-hoc exploration; for dense dashboards, jump to Grafana.

### Traces

Tempo search by `service.name`. Results show trace id, root service, root
name, span count, duration. Clicking a trace deep-links into Tempo's native
trace view.

## Deep-link recipe

Every service view elsewhere in the console can build a logs query via:

```ts
import { lgtm } from '@adhar-console/api-clients'
const url = lgtm.LgtmClient.stub().grafanaEmbedUrl('golden-signals', {
  'var-service': 'adhar-console',
})
```

— and the Discover tab will render it without another sign-in.

## Performance

- Loki: tail queries (`follow: true`) stream via server-sent events —
  planned for v0.3.x.
- Mimir: the sparkline picks up to 60 points per series; heavier use cases
  should use Grafana.
- Tempo: searches are bucketed (start/end) to avoid full-scan cost.
