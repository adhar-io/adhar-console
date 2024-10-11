import {createPlugin, createComponentExtension} from '@backstage/core-plugin-api';

import {rootRouteRef} from './routes';

export const cnoeFrontendPlugin = createPlugin({
  id: 'adhar-console-plugin',
  routes: {
    root: rootRouteRef,
  },
});

export const AWSLogoFull = cnoeFrontendPlugin
  .provide(
    createComponentExtension({
      name: 'LogoFull',
      component: {lazy: () => import('./components/logos/AdharLogo').then(m => m.AdharLogo)},
    }),
  );

export const AWSLogoIcon = cnoeFrontendPlugin
  .provide(
    createComponentExtension({
      name: 'LogoIcon',
      component: {lazy: () => import('./components/logos/AdharIcon').then(m => m.AdharIcon)},
    }),
  );

export const CNOEHomepage = cnoeFrontendPlugin
  .provide(
    createComponentExtension({
      name: 'Homepage',
      component: {
        lazy: () => import('./components/Homepage').then(m => m.CNOEHomepage),
      },
    }),
  );
