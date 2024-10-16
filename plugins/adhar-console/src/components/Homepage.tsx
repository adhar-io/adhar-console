import { Content, Page } from '@backstage/core-components';
import { SearchContextProvider } from '@backstage/plugin-search-react';
import { Grid } from '@material-ui/core';
import React from 'react';

import {
  HomePageToolkit,
  HomePageStarredEntities,
  TemplateBackstageLogoIcon,
} from '@backstage/plugin-home';
import { Graph } from './Graph';
import { Activity } from './Activity';

export const AdharConsoleHomepage = () => {

  return (
    <SearchContextProvider>
      <Page themeId="home">
        <Content>
          <Grid container justifyContent="center" spacing={6}>
            <Grid container item xs={12} alignItems="center" direction="row">
              <Graph />
            </Grid>
            <Grid container item xs={12}>
              <Grid item xs={12} md={6}>
                <HomePageStarredEntities />
                <br />
                <Activity />
              </Grid>
              <Grid item xs={12} md={6}>
                <HomePageToolkit
                  title="Platform Apps"
                  tools={[
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                    {
                      url: '/catalog',
                      label: 'Catalog',
                      icon: <TemplateBackstageLogoIcon/>,
                    },
                    {
                      url: '/docs',
                      label: 'Tech Docs',
                      icon: <TemplateBackstageLogoIcon />,
                    },
                  ]}
                />
              </Grid>
            </Grid>
          </Grid>
        </Content>
      </Page>
    </SearchContextProvider>
  );
};
