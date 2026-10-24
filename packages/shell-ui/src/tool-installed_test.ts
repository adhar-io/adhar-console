import { assertEquals } from 'jsr:@std/assert@1'
import { toolInstalled } from './app-config.ts'

const routes = [{ id: 'grafana', url: 'https://grafana.dev.adhar.io' }]

Deno.test('with route evidence, only routed or operator-set tools count as installed', () => {
  const cfg = { tools: { mlflow: { configured: true, url: 'https://mlflow.dev.adhar.io', explicit: false }, ext: { configured: true, url: 'https://ext.example.com', explicit: true } }, discoveredApps: routes }
  assertEquals(toolInstalled(cfg, 'grafana'), true)
  assertEquals(toolInstalled(cfg, 'mlflow'), false)
  assertEquals(toolInstalled(cfg, 'ext'), true)
})

Deno.test('without route evidence nothing is hidden', () => {
  assertEquals(toolInstalled(undefined, 'mlflow'), true)
  assertEquals(toolInstalled({ tools: {}, discoveredApps: [] }, 'mlflow'), true)
})
