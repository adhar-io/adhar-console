import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  attributedActor,
  markdownToHtml,
  mentionedIds,
  renderMentions,
  safeUrl,
  sanitizeHtml,
  toCsv,
  withAttribution,
} from './work-text.ts'

Deno.test('sanitizer keeps Plane formatting and drops everything dangerous', () => {
  assertEquals(sanitizeHtml('<p class="x">Hi <strong>there</strong></p>'), '<p>Hi <strong>there</strong></p>')
  assertEquals(sanitizeHtml('<script>alert(1)</script><p>ok</p>'), '<p>ok</p>')
  assertEquals(sanitizeHtml('<img src=x onerror="alert(1)">'), '<img src="x">')
  assertEquals(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a target="_blank" rel="noreferrer noopener">x</a>')
  assertEquals(sanitizeHtml('<a href="jav&#x09;ascript:alert(1)">x</a>').includes('href'), false)
  assertEquals(sanitizeHtml('<a href="//evil.example/x">x</a>').includes('href'), false)
  assertEquals(sanitizeHtml('<a href="https://ok.io/a?b=1&c=2">x</a>'), '<a href="https://ok.io/a?b=1&amp;c=2" target="_blank" rel="noreferrer noopener">x</a>')
  assertEquals(sanitizeHtml('<div style="background:url(x)" onclick="y">t</div>'), '<div>t</div>')
  assertEquals(sanitizeHtml('<iframe src="https://x"></iframe>after'), 'after')
  assertEquals(sanitizeHtml('a < b > c'), 'a &lt; b &gt; c')
  assertEquals(sanitizeHtml('<svg><script>x</script></svg>ok'), 'ok')
  assertEquals(sanitizeHtml('<img src="data:image/png;base64,AAAA">'), '<img src="data:image/png;base64,AAAA">')
  assertEquals(sanitizeHtml('<img src="data:text/html;base64,AAAA">'), '<img>')
  assertEquals(sanitizeHtml('<p title="a&quot;b">x</p>'), '<p>x</p>')
  assertEquals(
    sanitizeHtml('<ul data-type="taskList"><li data-checked="true">done</li></ul>'),
    '<ul data-type="taskList"><li data-checked="true">done</li></ul>',
  )
  assertEquals(sanitizeHtml(null), '')
})

Deno.test('safeUrl', () => {
  assertEquals(safeUrl('https://x.io', 'href'), 'https://x.io')
  assertEquals(safeUrl('/define?section=issues', 'href'), '/define?section=issues')
  assertEquals(safeUrl('mailto:a@b.c', 'href'), 'mailto:a@b.c')
  assertEquals(safeUrl(' JaVaScRiPt:alert(1)', 'href'), undefined)
  assertEquals(safeUrl('vbscript:x', 'href'), undefined)
})

Deno.test('markdown → Plane HTML with mentions', () => {
  const html = markdownToHtml('Hi @Ada, see **this** and `code <x>`\nnext line\n\n- one\n- [two](https://x.io)\n\n- [x] done\n- [ ] todo\n\n```\n<b>raw</b>\n```', [{ id: 'u1', handle: 'Ada' }])
  assert(html.startsWith('<p>Hi <mention-component entity_identifier="u1" entity_name="user_mention"></mention-component>, see <strong>this</strong> and <code>code &lt;x&gt;</code><br>next line</p>'))
  assert(html.includes('<ul><li><p>one</p></li><li><p><a href="https://x.io">two</a></p></li></ul>'))
  assert(html.includes('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li><li data-type="taskItem" data-checked="false"><p>todo</p></li></ul>'))
  assert(html.includes('<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>'))
  // Unknown handles and emails stay as text.
  assertEquals(markdownToHtml('mail bob@x.io or @nobody', [{ id: 'u1', handle: 'Ada' }]), '<p>mail bob@x.io or @nobody</p>')
  // Links with unsafe schemes stay literal text.
  assertEquals(markdownToHtml('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>')
  assertEquals(markdownToHtml('# Title\n> quoted\n1. a\n2. b'), '<h1>Title</h1><blockquote><p>quoted</p></blockquote><ol><li><p>a</p></li><li><p>b</p></li></ol>')
})

Deno.test('mentions render as names and can be listed', () => {
  const html = sanitizeHtml('<p>cc <mention-component entity_identifier="u1" entity_name="user_mention" onclick="x"></mention-component></p>')
  assertEquals(mentionedIds(html), ['u1'])
  assertEquals(renderMentions(html, (id) => (id === 'u1' ? 'Ada' : undefined)), '<p>cc <span class="adhar-mention" data-user="u1">@Ada</span></p>')
})

Deno.test('attribution is appended once and read back', () => {
  const once = withAttribution('<p>x</p>', { name: 'Ada <L>' })
  assertEquals(once, '<p>x</p><p data-adhar-actor=""><em>— via Adhar console by Ada &lt;L&gt;</em></p>')
  assertEquals(withAttribution(once, { name: 'Bob' }), once)
  assertEquals(withAttribution('<p>x</p>', null), '<p>x</p>')
  assertEquals(attributedActor(once), 'Ada &lt;L&gt;')
  // Survives the sanitiser (attribute stripped, text kept).
  assertEquals(attributedActor(sanitizeHtml(once)), 'Ada &lt;L&gt;')
})

Deno.test('CSV quoting and formula guard', () => {
  assertEquals(toCsv([['Key', 'Title'], ['CON-1', 'a, "b"'], ['CON-2', '=SUM(A1)'], ['CON-3', null]]), 'Key,Title\r\nCON-1,"a, ""b"""\r\nCON-2,\'=SUM(A1)\r\nCON-3,')
})
