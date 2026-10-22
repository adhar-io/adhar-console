/**
 * Load the parser a framework's templates need — each one a lazy chunk, only
 * fetched when a repository of that framework is opened.
 */
import type { Dialect } from '../markup.ts';
import type { MarkupParsers } from './types.ts';

export async function loadMarkupParsers(dialect: Dialect): Promise<MarkupParsers> {
  switch (dialect) {
    case 'vue':
      return { vue: (await import('./vue.ts')).parseVue };
    case 'svelte':
      return { svelte: (await import('./svelte.ts')).parseSvelte };
    case 'angular':
      return { angular: (await import('./angular.ts')).parseAngularTemplate };
    case 'html':
      return { html: (await import('./html.ts')).parseHtml };
  }
}
