import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert'
import { REDACTED, redactObject, redactText } from './redact.ts'

/** Each line is shaped like something seen in a real pod log on the platform. */
const CASES: Array<[string, string, string]> = [
  ['authorization header', 'GET /api/v1/x HTTP/1.1 Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMyJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJlLXZhbHVl', 'eyJhbGci'],
  ['bare bearer', 'calling keycloak with Bearer abcdef0123456789abcdef', 'abcdef0123456789'],
  ['jwt anywhere', 'token=none id_token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'dozjgNryP4J3'],
  ['postgres url', 'connecting to postgresql://keycloak:S3cr3t!pw@keycloak-db-rw.adhar-system:5432/keycloak', 'S3cr3t!pw'],
  ['jdbc password param', 'jdbc:postgresql://db:5432/app?user=app&password=hunter22&ssl=true', 'hunter22'],
  ['logfmt', 'level=info msg="login" client_secret=Zx9yQ8wR7 user=alice', 'Zx9yQ8wR7'],
  ['yaml env', '  DB_PASSWORD: "p4ssw0rd-value"', 'p4ssw0rd-value'],
  ['json', '{"user":"svc","apiKey":"plane_api_0123456789abcdef0123","ok":true}', 'plane_api_0123'],
  ['aws key', 'using AKIAIOSFODNN7EXAMPLE for s3', 'AKIAIOSFODNN7EXAMPLE'],
  ['github token', 'git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y', 'ghp_abcdefghijklmnop'],
  ['x-api-key header', 'x-api-key: 9b7e4f1a2c3d', '9b7e4f1a2c3d'],
  ['cookie', 'Cookie: _adhar_sso_console=abc.def.ghi; other=1', 'abc.def.ghi'],
  ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA'],
]

for (const [name, line, secret] of CASES) {
  Deno.test(`redactText removes the secret: ${name}`, () => {
    const out = redactText(line)
    assert(!out.includes(secret), `${name}: "${out}" still contains the secret`)
    assertStringIncludes(out, REDACTED)
  })
}

Deno.test('redactText leaves ordinary diagnostics alone', () => {
  const lines = [
    '16:16:38.066 [main] ERROR org.springframework.boot.SpringApplication -- Application run failed',
    'Startup probe failed: Get "http://10.244.9.139:8080/actuator/health/liveness": dial tcp 10.244.9.139:8080: connect: connection refused',
    'tokenizer loaded 32000 entries; maxTokens=4096',
    'Back-off restarting failed container app in pod gateway-service-689ffd8cf6-7kj2j_dev',
  ]
  for (const l of lines) assertEquals(redactText(l), l)
})

Deno.test('redactObject drops Secret data, secret-named fields, secret env values and managedFields', () => {
  const out = redactObject({
    kind: 'Secret',
    metadata: { name: 'x', managedFields: [{ manager: 'kubectl' }], annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"password":"aGk="}}' } },
    data: { password: 'aGk=' },
  }) as Record<string, unknown>
  assertEquals(out.data, REDACTED)
  assertEquals((out.metadata as Record<string, unknown>).managedFields, undefined)
  assertEquals(((out.metadata as Record<string, unknown>).annotations as Record<string, unknown>)['kubectl.kubernetes.io/last-applied-configuration'], undefined)

  const pod = redactObject({
    spec: { containers: [{ env: [{ name: 'DATABASE_PASSWORD', value: 'plain' }, { name: 'LOG_LEVEL', value: 'debug' }] }] },
    status: { message: 'auth failed for postgres://u:pw123@db/x', clientSecret: 'abc' },
  }) as { spec: { containers: Array<{ env: Array<{ value: string }> }> }; status: Record<string, string> }
  assertEquals(pod.spec.containers[0].env[0].value, REDACTED)
  assertEquals(pod.spec.containers[0].env[1].value, 'debug')
  assertEquals(pod.status.clientSecret, REDACTED)
  assert(!pod.status.message.includes('pw123'))
})
