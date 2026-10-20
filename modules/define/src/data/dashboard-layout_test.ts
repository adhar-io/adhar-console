import { assertEquals } from 'jsr:@std/assert@1'
import { addWidget, defaultLayout, moveWidget, normalizeLayout, removeWidget, resizeWidget, WIDGETS } from './dashboard-layout.ts'

Deno.test('default layout carries every widget once', () => {
  const l = defaultLayout()
  assertEquals(l.widgets.length, WIDGETS.length)
  assertEquals(new Set(l.widgets.map((w) => w.id)).size, WIDGETS.length)
  assertEquals(l.scope, 'project')
})

Deno.test('add / remove / move / resize', () => {
  let l = { ...defaultLayout(), widgets: defaultLayout().widgets.slice(0, 3) }
  assertEquals(l.widgets.map((w) => w.id), ['counters', 'my-open', 'due-soon'])
  l = addWidget(l, 'my-open')
  assertEquals(l.widgets[3].id, 'my-open-2')
  l = moveWidget(l, 'my-open-2', 0)
  assertEquals(l.widgets.map((w) => w.id), ['my-open-2', 'counters', 'my-open', 'due-soon'])
  l = moveWidget(l, 'counters', 99)
  assertEquals(l.widgets[3].id, 'counters')
  l = resizeWidget(l, 'counters', 's')
  assertEquals(l.widgets[3].size, 's')
  l = removeWidget(l, 'my-open')
  assertEquals(l.widgets.map((w) => w.id), ['my-open-2', 'due-soon', 'counters'])
})

Deno.test('normalize drops unknown widgets, duplicates and bad sizes', () => {
  const l = normalizeLayout({
    scope: 'team',
    widgets: [
      { id: 'a', type: 'okrs', size: 'xl' },
      { id: 'a', type: 'intake', size: 's' },
      { id: 'b', type: 'nope', size: 's' },
      null,
    ],
  })
  assertEquals(l.scope, 'team')
  assertEquals(l.widgets, [{ id: 'a', type: 'okrs', size: 'm' }])
  assertEquals(normalizeLayout(undefined).widgets.length, WIDGETS.length)
})
