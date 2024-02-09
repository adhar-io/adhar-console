import {
    Card,
    CardContent,
  } from "@/components/card";
import { Separator } from "@/components/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/popover";
import { RxDashboard } from "react-icons/rx";
import { ScrollArea } from "@/components/scroll-area";

import keycloakLogo from '@/assets/imgs/Keycloak_Logo.png';
import GiteaLogo from '@/assets/imgs/Gitea_Logo.png';
import HarborLogo from '@/assets/imgs/harbor.svg';
import ArgocdLogo from '@/assets/imgs/argocd.webp';
import GrafanaLogo from '@/assets/imgs/grafana.png';
import CertManagerLogo from '@/assets/imgs/cert-manager.png';
import TektonLogo from '@/assets/imgs/tecton.png';
import BackstageLogo from '@/assets/imgs/backstage.webp';
import MetabseLogo from '@/assets/imgs/metabase.jpeg';
import HeadlampLogo from '@/assets/imgs/headlamp.jpeg';
import PrometheusLogo from '@/assets/imgs/prometheus.png';
import KubearmourLogo from '@/assets/imgs/kubearmour.png';
import MinioLogo from '@/assets/imgs/minio.png';
import ThanosLogo from '@/assets/imgs/thanos.png';
import TrivyLogo from '@/assets/imgs/trivy.png';
import CnpgLogo from '@/assets/imgs/cnpg.png';
import FalcoLogo from '@/assets/imgs/falco.png';
import AlertManagerLogo from '@/assets/imgs/alertmanager.png';
import PosthogLogo from '@/assets/imgs/posthog.png';
import LokiLogo from '@/assets/imgs/loki.png';
import TempoLogo from '@/assets/imgs/tempo.png';
import IstioLogo from '@/assets/imgs/istio.png';
import KnativeLogo from '@/assets/imgs/knative.png';
import PlaneLogo from '@/assets/imgs/plane.png';
import VeleroLogo from '@/assets/imgs/velero.png';
import StrapiLogo from '@/assets/imgs/strapi.png';
import CloudshellLogo from '@/assets/imgs/cloudshell.png';
import AssistLogo from '@/assets/imgs/assist.png';
import CanvasLogo from '@/assets/imgs/canvas.webp';
import CoderLogo from '@/assets/imgs/coder.png';
import WebstudioLogo from '@/assets/imgs/webstudio.png';
import DevspaceLogo from '@/assets/imgs/devspace.png';
import DagsterLogo from '@/assets/imgs/dagster.png';
import DbtLogo from '@/assets/imgs/dbt.png';
import AirbyteLogo from '@/assets/imgs/airbyte.png';
import KyvernoLogo from '@/assets/imgs/kyverno.png';
import RedisLogo from '@/assets/imgs/redis.png';
import KafkaLogo from '@/assets/imgs/kafka.png';
import CasandraLogo from '@/assets/imgs/casandra.png';
import SupabaseLogo from '@/assets/imgs/supabase.png';
import RabbitMQLogo from '@/assets/imgs/rabbitmq.png';
import OpenFnLogo from '@/assets/imgs/openfunction.png';
import DaprLogo from '@/assets/imgs/dapr.png';
import ApisixLogo from '@/assets/imgs/apisix.svg';
import SealedSecreatsLogo from '@/assets/imgs/sealed-secrets.png';

export function QuickAccess() {
  const apps = [
    {label: 'Gitea', logo: `${GiteaLogo}`, alt: 'Gitea Logo'},
    {label: 'Tekton', logo: `${TektonLogo}`, alt: 'Tekton Logo'},
    {label: 'Harbor', logo: `${HarborLogo}`, alt: 'Harbor Logo'},
    {label: 'Argo CD', logo: `${ArgocdLogo}`, alt: 'Argocd Logo'},
    {label: 'Headlamp', logo: `${HeadlampLogo}`, alt: 'Headlamp Logo'},
    {label: 'Keycloak', logo: `${keycloakLogo}`, alt: 'Keycloak Logo'},
    {label: 'Kyverno', logo: `${KyvernoLogo}`, alt: 'Kyverno Logo'},
    {label: 'Kubearmour', logo: `${KubearmourLogo}`, alt: 'Kubearmour Logo'},
    {label: 'Trivy', logo: `${TrivyLogo}`, alt: 'Trivy Logo'},
    {label: 'Falco', logo: `${FalcoLogo}`, alt: 'Falco Logo'},
    {label: 'Plane', logo: `${PlaneLogo}`, alt: 'Plane Logo'},
    {label: 'Backstage', logo:`${BackstageLogo}`, alt: 'Backstage Logo'},
    {label: 'Apisix', logo: `${ApisixLogo}`, alt: 'Apisix Logo'},
    {label: 'Dapr', logo: `${DaprLogo}`, alt: 'Dapr Logo'},
    {label: 'Posthog', logo: `${PosthogLogo}`, alt: 'Posthog Logo'},
    {label: 'Postgres', logo: `${CnpgLogo}`, alt: 'CNPG Logo'},
    {label: 'Redis', logo: `${RedisLogo}`, alt: 'Redis Logo'},
    {label: 'Kafka', logo: `${KafkaLogo}`, alt: 'Kafka Logo'},
    {label: 'Casandra', logo: `${CasandraLogo}`, alt: 'Casandra Logo'},
    {label: 'RabbitMQ', logo: `${RabbitMQLogo}`, alt: 'RabbitMQ Logo'},
    {label: 'Dagster', logo: `${DagsterLogo}`, alt: 'Dagster Logo'},
    {label: 'Airbyte', logo: `${AirbyteLogo}`, alt: 'Airbyte Logo'},
    {label: 'DBT', logo: `${DbtLogo}`, alt: 'DBT Logo'},
    {label: 'Minio', logo: `${MinioLogo}`, alt: 'Minio Logo'},
    {label: 'Metabase', logo: `${MetabseLogo}`, alt: 'Metabase Logo'},
    {label: 'WebBuilder', logo: `${WebstudioLogo}`, alt: 'Builder Logo'},
    {label: 'Canvas', logo: `${CanvasLogo}`, alt: 'Canvas Logo'},
    {label: 'Assist', logo: `${AssistLogo}`, alt: 'Assist Logo'},
    {label: 'CloudShell', logo: `${CloudshellLogo}`, alt: 'Cloudshell Logo'},
    {label: 'Coder IDE', logo: `${CoderLogo}`, alt: 'Coder Logo'},
    {label: 'Grafana', logo: `${GrafanaLogo}`, alt: 'Grafana Logo'},
    {label: 'Loki', logo: `${LokiLogo}`, alt: 'Loki Logo'},
    {label: 'Alerts', logo: `${AlertManagerLogo}`, alt: 'AlertManager Logo'},
    {label: 'Tempo', logo: `${TempoLogo}`, alt: 'Tempo Logo'},
    {label: 'Prometheous', logo: `${PrometheusLogo}`, alt: 'Prometheus Logo'},
    {label: 'Thanos', logo: `${ThanosLogo}`, alt: 'Thanos Logo'},
    {label: 'Istio', logo: `${IstioLogo}`, alt: 'Istio Logo'},
    {label: 'Knative', logo: `${KnativeLogo}`, alt: 'Knative Logo'},
    {label: 'FaaS', logo: `${OpenFnLogo}`, alt: 'OpenFunction Logo'},
    {label: 'Velero', logo: `${VeleroLogo}`, alt: 'Velero Logo'},
    {label: 'Strapi', logo: `${StrapiLogo}`, alt: 'Strapi Logo'},
    {label: 'Supabase', logo: `${SupabaseLogo}`, alt: 'Supabase Logo'},
    {label: 'DevSpace', logo: `${DevspaceLogo}`, alt: 'DevSpace Logo'},
    {label: 'Secrets', logo: `${SealedSecreatsLogo}`, alt: 'Secrets Logo'},
    {label: 'CertManager', logo: `${CertManagerLogo}`, alt: 'CertManager Logo'}
  ];

  return (
    <Popover>
      <PopoverTrigger>
        <RxDashboard size='24' className='top-navigation-icon' />
      </PopoverTrigger>
      <PopoverContent className="w-max mt-4 h-800">
        <div className="grid gap-4">
          <div className="space-y-2">
            <h4 className="font-medium leading-none">Quick Access</h4>
            <p className="text-sm text-muted-foreground">
              Access all your frequently used apps here.
            </p>
          </div>
          <Separator className="my-2" />
          <ScrollArea className="rounded-md h-675 no-scrollbar">
            <div className="grid grid-cols-5 gap-4">
              {apps.map((app, index) => (
                <Card key={index} className="w-[120px] h-[120px] bg-accent shadow-md hover:shadow-lg">
                  <CardContent className="flex flex-col justify-center items-center pt-6">
                  <div className="flex flex-col items-center justify-center w-full">
                      <img
                          src={app.logo}
                          className="rounded-md object-contain w-14 h-14"
                          alt={app.alt}
                      />
                      <div className="text-center text-sm text-muted-foreground w-full">
                          {app.label}
                      </div>
                  </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  )
}
