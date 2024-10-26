import {
  genPageTheme,
  shapes,
  createUnifiedTheme,
  createBaseThemeOptions, palettes,
} from '@backstage/theme';

export const adharLightTheme = createUnifiedTheme({
  ...createBaseThemeOptions({
    palette: {
      ...palettes.light,
      primary: {
        main: '#5A00B0',
      },
      secondary: {
        main: '#00adee',
      },
    },
  }),
  defaultPageTheme: 'home',
  pageTheme: {
    home: genPageTheme({colors: ['#5A00B0', '#00adee'], shape: shapes.wave2}),
    documentation: genPageTheme({
      colors: ['#5A00B0', '#00adee'],
      shape: shapes.wave2,
    }),
    tool: genPageTheme({colors: ['#5A00B0', '#00adee'], shape: shapes.round}),
    service: genPageTheme({
      colors: ['#5A00B0', '#00adee'],
      shape: shapes.wave2,
    }),
    website: genPageTheme({
      colors: ['#5A00B0', '#00adee'],
      shape: shapes.wave2,
    }),
    library: genPageTheme({
      colors: ['#5A00B0', '#00adee'],
      shape: shapes.wave2,
    }),
    other: genPageTheme({colors: ['#5A00B0', '#00adee'], shape: shapes.wave2}),
    app: genPageTheme({colors: ['#5A00B0', '#00adee'], shape: shapes.wave2}),
    apis: genPageTheme({colors: ['#5A00B0', '#00adee'], shape: shapes.wave2}),
  },
});


