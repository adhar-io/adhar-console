import React from 'react';
import {
  Header,
  HeaderLabel,
  Page,
  Content,
  ContentHeader,
  SupportButton,
  InfoCard,
} from '@backstage/core-components';
import { Grid } from '@material-ui/core';
import { OverviewTable } from '../WorkflowOverview/WorkflowOverview';
import { useEntity } from '@backstage/plugin-catalog-react';
import { isArgoWorkflowsAvailable } from '../../plugin';
import { WorkflowTemplateTable } from '../WorkflowTemplateOverview/WorkflowTemplateOverview';

export const ArgoWorkflowsOverviewPage = () => (
  <Page themeId="tool">
    <Header title="Argo Workflows">
      <HeaderLabel label="Lifecycle" value="Alpha" />
    </Header>
    <Content>
      <ContentHeader title="Overview">
        <SupportButton>Overview of your Argo Workflows</SupportButton>
      </ContentHeader>
      <Grid item>
        <OverviewTable />
      </Grid>
      <Grid item>
        <WorkflowTemplateTable />
      </Grid>
    </Content>
  </Page>
);

export const ArgoWorkflowsOverviewCard = (props: { title?: string }) => {
  const { entity } = useEntity();
  if (isArgoWorkflowsAvailable(entity)) {
    return (
      <InfoCard {...{ title: props.title ?? 'Argo Workflows' }}>
        <OverviewTable />
      </InfoCard>
    );
  }
  return null;
};

export const ArgoWorkflowsTemplatesOverviewCard = () => {
  const { entity } = useEntity();
  if (isArgoWorkflowsAvailable(entity)) {
    return (
      <InfoCard {...{ title: 'Argo Workflows Templates' }}>
        <WorkflowTemplateTable />
      </InfoCard>
    );
  }
  return null;
};
