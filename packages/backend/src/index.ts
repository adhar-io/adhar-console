import { createBackend } from '@backstage/backend-defaults';
import { authModuleKeycloakOIDCProvider } from './plugins/auth';
import { cnoeScaffolderActions } from './plugins/scaffolder';
import { legacyPlugin } from '@backstage/backend-common';

const backend = createBackend();

// core plugins
backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));
backend.add(import('@backstage/plugin-techdocs-backend'));
// auth plugins
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
// scaffolder plugins
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));

// search plugin
backend.add(import('@backstage/plugin-search-backend'));

// search engines
backend.add(import('@backstage/plugin-search-backend-module-pg'));

// search collators
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

// other @backstage plugins
backend.add(import('@backstage/plugin-kubernetes-backend'));
// non-core plugins
// roadie plugins
// backend.add(import('@roadiehq/scaffolder-backend-module-utils/new-backend'));
backend.add(legacyPlugin('argocd', import('./plugins/argocd')));
// cnoe plugins
backend.add(authModuleKeycloakOIDCProvider);
backend.add(cnoeScaffolderActions);
backend.add(import('@internal/backstage-plugin-terraform-backend'));

backend.start();
