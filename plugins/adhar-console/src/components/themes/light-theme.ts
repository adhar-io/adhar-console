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
        main: '#6366f1',
      },
      secondary: {
        main: '#2dd4bf',
      },
      bursts: {
        fontColor: '#fff',
        slackChannelText: '#000',
        backgroundColor: {
          default: '#6366f1',
        },
        gradient: {
          linear: 'linear-gradient(180deg, #6366f1 0%, #2dd4bf 100%)',
        },
      },
    },
  }),
  defaultPageTheme: 'home',
  pageTheme: {
    home: genPageTheme({
      colors: ['#6366f1', '#6366f1'], 
      shape: shapes.wave2
    }),
    documentation: genPageTheme({
      colors: ['#6366f1', '#6366f1'],
      shape: shapes.wave2,
    }),
    tool: genPageTheme({
      colors: ['#6366f1', '#6366f1'], 
      shape: shapes.round
    }),
    service: genPageTheme({
      colors: ['#6366f1', '#6366f1'],
      shape: shapes.wave2,
    }),
    website: genPageTheme({
      colors: ['#6366f1', '#6366f1'],
      shape: shapes.wave2,
    }),
    library: genPageTheme({
      colors: ['#6366f1', '#6366f1'],
      shape: shapes.wave2,
    }),
    other: genPageTheme({
      colors: ['#6366f1', '#6366f1'], 
      shape: shapes.wave2
    }),
    app: genPageTheme({
      colors: ['#6366f1', '#6366f1'], 
      shape: shapes.wave2
    }),
    apis: genPageTheme({
      colors: ['#6366f1', '#6366f1'], 
      shape: shapes.wave2
    }),
  },
});


