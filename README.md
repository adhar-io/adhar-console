# Adhar Console 

This repository contains code for `Adhar Console` which is developed based on [Backstage](https://backstage.io).

## Container Images

Container images are pushed to the GitHub Container Registry and available [here](https://github.com/adhar-io/adhar-console/pkgs/container/adhar-console).


## Getting Started

Use of [**adhar**](https://github.com/adhar-io/adhar) is recommended for local setup.

### Create your local cluster

```bash
./adhar up
```

Wait for ArgoCD applications to be healthy: 

```bash
$ kubectl get applications -A

NAMESPACE   NAME                  SYNC STATUS   HEALTH STATUS
argocd      argo-workflows        Synced        Healthy
argocd      argocd                Synced        Healthy
argocd      backstage             Synced        Healthy
argocd      backstage-templates   Synced        Healthy
argocd      coredns               Synced        Healthy
argocd      external-secrets      Synced        Healthy
argocd      gitea                 Synced        Healthy
argocd      keycloak              Synced        Healthy
argocd      metric-server         Synced        Healthy
argocd      nginx                 Synced        Healthy
argocd      spark-operator        Synced        Healthy
```

### Update Backstage application config

Once all ArgoCD applications are healthy, you need to update a few fields in the [app-config.yaml](./app-config.yaml) file.

#### Update control plane URL

The control plane port must be updated every time a cluster is created. Run the `kubectl cluster-info` command to get the control plane URL. Once you have your URL, update your `app-config.yaml` file.

For example:

```bash
$ kubectl cluster-info

Kubernetes control plane is running at https://127.0.0.1:36463
CoreDNS is running at https://127.0.0.1:36463/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy
```

For this particular example output, the `https://127.0.0.1:36463` above is the URL you need to use in your `app-config.yaml`.

#### Update service account token

Since tokens are generated each time the backstage service account is created, you need to update this value as well. The command to retrieve the service account token is:

`kubectl -n backstage exec -it deploy/backstage  -- cat /var/run/secrets/kubernetes.io/serviceaccount/token`  

Copy the token value and updated the app-config file at [this line](https://github.com/cnoe-io/backstage-app/blob/main/app-config.yaml#L127).

For example:

```bash
$ kubectl -n backstage exec -it deploy/backstage -- cat /var/run/secrets/kubernetes.io/serviceaccount/token

eyJhbGciOiJSUzI1NiIsImtpZCI6IkRxbDRCSnNicjFwekFqdmxwNDc5MHJqeUlFSjhxNHU0LV95OC1s...
```

If you do not want to place the token value in your file, you can use environment variables instead:
1. Set [this line](https://github.com/cnoe-io/backstage-app/blob/main/app-config.yaml#L127) value to be `${BACKSTAGE_SA_TOKEN}`.
2. Then export the token value:
   ```bash
   export BACKSTAGE_SA_TOKEN=$(kubectl -n backstage exec -it deploy/backstage -- cat /var/run/secrets/kubernetes.io/serviceaccount/token)
   ```

#### Update ArgoCD token

ArgoCD admin passwords are generated on each fresh installation. You need to update the configuration file accordingly. To obtain your password, run: `adhar get secrets -p argocd`. Then update [this line](https://github.com/cnoe-io/backstage-app/blob/9ee3514e51c1a354b7fe85a90117faf8328bfa0b/app-config.yaml#L136)

For example:

```bash
$ adhar get secrets -p argocd

---------------------------
Name: argocd-initial-admin-secret
Namespace: argocd
Data:
  password : abc
  username : admin
```

#### Update Gitea Credentials

Gitea admin passwords are generated on each fresh installation as well. To obtain your password, run: `adhar get secrets -p argocd`.
Then update [this line](https://github.com/cnoe-io/backstage-app/blob/9ee3514e51c1a354b7fe85a90117faf8328bfa0b/app-config.yaml#L40) and [this line](https://github.com/cnoe-io/backstage-app/blob/9ee3514e51c1a354b7fe85a90117faf8328bfa0b/app-config.yaml#L44).

For example:

```bash
$ adhar get secrets -p gitea

---------------------------
Name: gitea-credential
Namespace: gitea
Data:
  password : abc
  username : giteaAdmin
````

### Start Backstage processes

Once the `app-config.yaml` file is updated, you are ready to start your backstage instance. For development purposes, using two terminal windows or tabs is recommended. You can also run them through your favorite IDE.

In the first terminal tab, install dependencies and start the backend.

```bash
yarn install
yarn run start-backend
```

In the first terminal tab, run the frontend.

```bash
yarn run start
```
