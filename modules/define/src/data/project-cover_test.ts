import { assertEquals } from 'jsr:@std/assert@1'
import { coverImageUrl, decodeEmoji, projectEmoji, projectIconColor } from './project-cover.ts'

Deno.test('decodeEmoji reads Plane code points and passes glyphs through', () => {
  assertEquals(decodeEmoji('128640'), '🚀')
  assertEquals(decodeEmoji('9917-65039'), '⚽️')
  assertEquals(decodeEmoji('🛰️'), '🛰️')
  assertEquals(decodeEmoji('rocket'), undefined)
  assertEquals(decodeEmoji(''), undefined)
  assertEquals(decodeEmoji(null), undefined)
})

Deno.test('projectEmoji prefers logo_props, honours icon mode', () => {
  assertEquals(projectEmoji({ logo_props: { in_use: 'emoji', emoji: { value: '127775' } }, emoji: '128640' }), '🌟')
  assertEquals(projectEmoji({ emoji: '128640' }), '🚀')
  assertEquals(projectEmoji({ logo_props: { in_use: 'icon', icon: { name: 'home', color: '#6d28d9' } }, emoji: '128640' }), undefined)
  assertEquals(projectIconColor({ logo_props: { in_use: 'icon', icon: { name: 'home', color: '#6d28d9' } } }), '#6d28d9')
  assertEquals(projectIconColor({ logo_props: { in_use: 'icon', icon: { color: 'red;background:url(x)' } } }), undefined)
})

Deno.test('coverImageUrl routes Plane paths through the proxy', () => {
  assertEquals(coverImageUrl({ cover_image_url: '/api/assets/v2/static/abc/' }), '/api/svc/plane/api/assets/v2/static/abc/')
  assertEquals(coverImageUrl({ cover_image_asset: 'abc' }), '/api/svc/plane/api/assets/v2/static/abc/')
  assertEquals(coverImageUrl({ cover_image: 'https://images.unsplash.com/photo-1?w=1' }), 'https://images.unsplash.com/photo-1?w=1')
  assertEquals(coverImageUrl({ cover_image: 'https://plane.example.io/api/assets/v2/static/x/' }, 'https://plane.example.io/'), '/api/svc/plane/api/assets/v2/static/x/')
  assertEquals(coverImageUrl({ cover_image_url: '', cover_image: null }), undefined)
  assertEquals(coverImageUrl({ cover_image: 'javascript:alert(1)' }), undefined)
  assertEquals(coverImageUrl(undefined), undefined)
})
