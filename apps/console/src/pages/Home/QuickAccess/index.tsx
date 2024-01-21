import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
  } from "@/components/card";
import { AspectRatio } from "@/components/aspect-ratio"
import { Separator } from "@/components/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/popover";
import { RxDashboard } from "react-icons/rx";

import keycloakLogo from '@/assets/imgs/Keycloak_Logo.png';
import GiteaLogo from '@/assets/imgs/Gitea_Logo.png';
import HarborLogo from '@/assets/imgs/harbor.svg';
import ArgocdLogo from '@/assets/imgs/argocd.webp';
import GrafanaLogo from '@/assets/imgs/grafana.png';
import CertManagerLogo from '@/assets/imgs/cert-manager.png';
import TektonLogo from '@/assets/imgs/tecton.png';
import BackstageLogo from '@/assets/imgs/backstage.webp';
import MetabseLogo from '@/assets/imgs/metabase.png';
import HeadlampLogo from '@/assets/imgs/headlamp.jpeg';
import PrometheusLogo from '@/assets/imgs/prometheus.png';
import GatekeeperLogo from '@/assets/imgs/opa.png';
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

export function QuickAccess() {
  const apps = [
    {label: 'Keycloak', logo: `${keycloakLogo}`, alt: 'Keycloak Logo'},
    {label: 'Gitea', logo: `${GiteaLogo}`, alt: 'Gitea Logo'},
    {label: 'Harbor', logo: `${HarborLogo}`, alt: 'Harbor Logo'},
    {label: 'Argo CD', logo: `${ArgocdLogo}`, alt: 'Argocd Logo'},
    {label: 'Grafana', logo: `${GrafanaLogo}`, alt: 'Grafana Logo'},
    {label: 'Plane', logo: `${PlaneLogo}`, alt: 'Plane Logo'},
    {label: 'Backstage', logo:`${BackstageLogo}`, alt: 'Backstage Logo'},
    {label: 'Headlamp', logo: `${HeadlampLogo}`, alt: 'Headlamp Logo'},
    {label: 'Tekton', logo: `${TektonLogo}`, alt: 'Tekton Logo'},
    {label: 'Metabase', logo: `${MetabseLogo}`, alt: 'Metabase Logo'},
    {label: 'Posthog', logo: `${PosthogLogo}`, alt: 'Posthog Logo'},
    {label: 'Loki', logo: `${LokiLogo}`, alt: 'Loki Logo'},
    {label: 'Alert Manager', logo: `${AlertManagerLogo}`, alt: 'AlertManager Logo'},
    {label: 'Tempo', logo: `${TempoLogo}`, alt: 'Tempo Logo'},
    {label: 'Thanos', logo: `${ThanosLogo}`, alt: 'Thanos Logo'},
    {label: 'Prometheous', logo: `${PrometheusLogo}`, alt: 'Prometheus Logo'},
    {label: 'Istio', logo: `${IstioLogo}`, alt: 'Istio Logo'},
    {label: 'Knative', logo: `${KnativeLogo}`, alt: 'Knative Logo'},
    {label: 'Gatekeeper', logo: `${GatekeeperLogo}`, alt: 'Gatekeeper Logo'},
    {label: 'Trivy', logo: `${TrivyLogo}`, alt: 'Trivy Logo'},
    {label: 'Falco', logo: `${FalcoLogo}`, alt: 'Falco Logo'},
    {label: 'Velero', logo: `${VeleroLogo}`, alt: 'Velero Logo'},
    {label: 'Minio', logo: `${MinioLogo}`, alt: 'Minio Logo'},
    {label: 'Cloudnative-pg', logo: `${CnpgLogo}`, alt: 'CNPG Logo'},
    {label: 'Cert Manager', logo: `${CertManagerLogo}`, alt: 'Grafana Logo'}
  ];

  return (
    <Popover>
      <PopoverTrigger>
        <RxDashboard size='24' className='top-navigation-icon' />
      </PopoverTrigger>
      <PopoverContent className="w-max mt-4">
        <div className="grid gap-4">
          <div className="space-y-2">
            <h4 className="font-medium leading-none">Quick Access</h4>
            <p className="text-sm text-muted-foreground">
              Access all your frequently used apps here.
            </p>
          </div>
          <Separator className="my-2" />
          <div className="grid grid-cols-5 gap-4">
            {apps.map((app, index) => (
              <Card key={index} className="w-[120px] h-[120px] bg-accent shadow-md hover:shadow-lg">
                <CardContent className="flex flex-col justify-center items-center pt-6">
                <div className="flex flex-col items-center justify-center w-full">
                    <img
                        src={app.logo}
                        className="rounded-md object-cover w-14"
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
        </div>
      </PopoverContent>
    </Popover>
  )
}
