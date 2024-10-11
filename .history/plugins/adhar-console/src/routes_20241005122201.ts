import { createRouteRef, searchRouteRef } from '@backstage/core-plugin-api';

export const rootRouteRef = createRouteRef({
  id: 'adhar-console',
});

export const searchRouteRef = createRouteRef({
  id: 'search'
});
