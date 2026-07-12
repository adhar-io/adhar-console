/**
 * Registry of federated remotes. The host reads this list at runtime.
 * `@module-federation/vite` rewrites `import('define/routes')` imports at
 * build time; this table is the runtime directory used by the remote loader
 * component (for discovery/listing) and by the dev server to announce ports.
 */
export const remoteRegistry = {
  define: { url: 'http://localhost:5101/mf/remoteEntry.js', devPort: 5101 },
  design: { url: 'http://localhost:5102/mf/remoteEntry.js', devPort: 5102 },
  develop: { url: 'http://localhost:5103/mf/remoteEntry.js', devPort: 5103 },
  deliver: { url: 'http://localhost:5104/mf/remoteEntry.js', devPort: 5104 },
  discover: { url: 'http://localhost:5105/mf/remoteEntry.js', devPort: 5105 },
  decide: { url: 'http://localhost:5106/mf/remoteEntry.js', devPort: 5106 },
  platform: { url: 'http://localhost:5107/mf/remoteEntry.js', devPort: 5107 },
  workspace: { url: 'http://localhost:5108/mf/remoteEntry.js', devPort: 5108 },
} as const

export type RemoteId = keyof typeof remoteRegistry
