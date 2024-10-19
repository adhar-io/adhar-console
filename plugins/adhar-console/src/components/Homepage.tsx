import { Content, Header, Page } from '@backstage/core-components';
import { SearchContextProvider } from '@backstage/plugin-search-react';
// eslint-disable-next-line no-restricted-imports
import { Grid } from '@mui/material';
import React from 'react';

import {
  HomePageToolkit,
  HomePageStarredEntities,
} from '@backstage/plugin-home';
import { Graph } from './Graph';
import { BrandIcon } from './logos';
import { Activity } from './Activity';
import KeycloakLogo from '../assets/logos/Keycloak_Logo.png';
import ArgoWorkflowLogo from '../assets/logos/workflows.png';
import ArgoCDLogo from '../assets/logos/argo.png';
import HeadlampLogo from '../assets/logos/headlamp.svg';
import CiliumLogo from '../assets/logos/cilium.png';
import GrafanaLogo from '../assets/logos/grafana.png';
import HarborLogo from '../assets/logos/harbor.svg';
import GiteaLogo from '../assets/logos/Gitea_Logo.png';
import MinIOLogo from '../assets/logos/minio.png';
import KyvernoLogo from '../assets/logos/kyverno.png';
import n8nLogo from '../assets/logos/n8n.png';
import OpenFuncLogo from '../assets/logos/openfunction.png';
import PlaneLogo from '../assets/logos/plane.png';
import PostHogLogo from '../assets/logos/posthog.png';
import MetabaseLogo from '../assets/logos/metabase.png';
import StorybookLogo from '../assets/logos/storybook.png';
import TrivyLogo from '../assets/logos/trivy.png';
import PrometheusLogo from '../assets/logos/prometheus.png';
import VeleroLogo from '../assets/logos/velero.png';
import StrapiLogo from '../assets/logos/strapi.png';
import WebstudioLogo from '../assets/logos/webstudio.png';
import SupabaseLogo from '../assets/logos/supabase.png';
import RedisLogo from '../assets/logos/redis.png';
import CnpgLogo from '../assets/logos/cnpg.png';
import RabbitMQLogo from '../assets/logos/rabbitmq.png';
import KafkaLogo from '../assets/logos/kafka.png';
import DbtLogo from '../assets/logos/dbt.png';
import CanvasLogo from '../assets/logos/tldraw_logo.jpeg';
import AssistLogo from '../assets/logos/ai.jpg';
import AirbyteLogo from '../assets/logos/airbyte.png';
import AlertManagerLogo from '../assets/logos/alertmanager.png';
import MongoDBLogo from '../assets/logos/mongodb-icon-1.svg';
import DagsterLogo from '../assets/logos/dagster.png';
import ShellLogo from '../assets/logos/cloudshell.png';
import FalcoLogo from '../assets/logos/falco.png';
import VaultLogo from '../assets/logos/vault-enterprise.svg';
import TrinoLogo from '../assets/logos/trino.png';
import CoderLogo from '../assets/logos/coder.png';
import LokiLogo from '../assets/logos/loki.png';
import MermaidLogo from '../assets/logos/mermaid.png';
import JaegerLogo from '../assets/logos/jaeger.png';
import LakeFSLogo from '../assets/logos/lakefs.jpg';
import OllamaLogo from '../assets/logos/ollama.png';
import OpenMetadataLogo from '../assets/logos/openmetadata.png';
import AgentBuilderLogo from '../assets/logos/robo.png';

export const AdharConsoleHomepage = () => {

  return (
    <SearchContextProvider>
      <Page themeId="home">
        <Header title="" subtitle="Welcome, Tapas Jena!" />
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
                      label: 'Keycloak',
                      icon: <BrandIcon logo={KeycloakLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Argo Workflows',
                      icon: <BrandIcon logo={ArgoWorkflowLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'Argo CD',
                      icon: <BrandIcon logo={ArgoCDLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Headlamp',
                      icon: <BrandIcon logo={HeadlampLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'Cilium',
                      icon: <BrandIcon logo={CiliumLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Grafana',
                      icon: <BrandIcon logo={GrafanaLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'Harbor',
                      icon: <BrandIcon logo={HarborLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Gitea',
                      icon: <BrandIcon logo={GiteaLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'MinIO',
                      icon: <BrandIcon logo={MinIOLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'Kyverno',
                      icon: <BrandIcon logo={KyvernoLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'n8n',
                      icon: <BrandIcon logo={n8nLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'OpenFunc',
                      icon: <BrandIcon logo={OpenFuncLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Plane',
                      icon: <BrandIcon logo={PlaneLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Coder',
                      icon: <BrandIcon logo={CoderLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'PostHog',
                      icon: <BrandIcon logo={PostHogLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'Proemtheus',
                      icon: <BrandIcon logo={PrometheusLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Alerts',
                      icon: <BrandIcon logo={AlertManagerLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Loki',
                      icon: <BrandIcon logo={LokiLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Jaeger',
                      icon: <BrandIcon logo={JaegerLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Storybook',
                      icon: <BrandIcon logo={StorybookLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'Trivy',
                      icon: <BrandIcon logo={TrivyLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Falco',
                      icon: <BrandIcon logo={FalcoLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Velero',
                      icon: <BrandIcon logo={VeleroLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'Strapi',
                      icon: <BrandIcon logo={StrapiLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Webstudio',
                      icon: <BrandIcon logo={WebstudioLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'Supabase',
                      icon: <BrandIcon logo={SupabaseLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Metabase',
                      icon: <BrandIcon logo={MetabaseLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Redis',
                      icon: <BrandIcon logo={RedisLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'CNPG',
                      icon: <BrandIcon logo={CnpgLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'RabitMQ',
                      icon: <BrandIcon logo={RabbitMQLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'DBT',
                      icon: <BrandIcon logo={DbtLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Kafka',
                      icon: <BrandIcon logo={KafkaLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'Airbyte',
                      icon: <BrandIcon logo={AirbyteLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'MongoDB',
                      icon: <BrandIcon logo={MongoDBLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Dagster',
                      icon: <BrandIcon logo={DagsterLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Trino',
                      icon: <BrandIcon logo={TrinoLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Vault',
                      icon: <BrandIcon logo={VaultLogo}/>,
                    },
                    {
                      url: '/catalog',
                      label: 'Canvas',
                      icon: <BrandIcon logo={CanvasLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Adhar Assist',
                      icon: <BrandIcon logo={AssistLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Shell',
                      icon: <BrandIcon logo={ShellLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Mermaid',
                      icon: <BrandIcon logo={MermaidLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'LakeFS',
                      icon: <BrandIcon logo={LakeFSLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Open Metadata',
                      icon: <BrandIcon logo={OpenMetadataLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Ollama',
                      icon: <BrandIcon logo={OllamaLogo}/>,
                    },
                    {
                      url: '/docs',
                      label: 'Agent Builder',
                      icon: <BrandIcon logo={AgentBuilderLogo}/>,
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
