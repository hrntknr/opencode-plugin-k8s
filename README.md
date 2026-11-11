# opencode-plugin-k8s

`opencode-plugin-k8s` is an OpenCode plugin that watches Kubernetes Deployments and reports failing ones in the OpenCode session that started the watch.

## Watch Model

Run `/k8s-watch` in a session to start watching. The plugin:

- lists Deployments through the Kubernetes API, using the default kubeconfig locations (same lookup as `kubectl`),
- watches one kubeconfig context, picked by the `--context` flag of `/k8s-watch`, the `context` parameter of the `k8s_watch` tool, or the `context` plugin option; without any of them the kubeconfig current context is used,
- by default lists Deployments in the namespace that the watched context declares, exactly like bare `kubectl get deployments` (`default` when the context declares none); the `namespaces` option restricts the watch to chosen namespaces, and `allNamespaces` widens it to the cluster scope like `kubectl get deployments -A`,
- pins the context and the watched namespaces when the watch starts, and reloads the kubeconfig on every poll only to refresh short-lived credentials (OIDC, exec); switching the machine's current context (`kubectl config use-context`) does not affect a running watch,
- skips namespaces whose list call is forbidden (HTTP 403) instead of failing the watch when several namespaces are watched, and names both the watched and the skipped namespaces in the start report,
- treats a Deployment as failing when its `Available` condition is `False`, its `Progressing` condition is `False` with reason `ProgressDeadlineExceeded`, or its `ReplicaFailure` condition is `True`,
- injects an initial report of the currently failing Deployments into the starting session,
- re-lists the Deployments on every poll and injects a prompt for each newly failing Deployment with `delivery: "queue"`, so the agent investigates it without interrupting an in-flight turn,
- keeps the failing set in plugin storage, so a plugin reload resumes the watch without re-reporting already known failures.

Deployments that recover leave the failing set silently; if the same Deployment fails again later, it is reported again.

Run `/k8s-watch stop` to clear the timer and the stored watch state. Running `/k8s-watch` again replaces an active watch. If listing fails before the watch starts (for example no reachable cluster), the session gets one prompt explaining the failure and the watch does not start. The same applies when every watched namespace forbids the list (HTTP 403): the watch does not start, and the explanation names the namespaces, suggests asking the operator for access, and points at the `namespaces`/`allNamespaces` options. Naming a context the kubeconfig does not know fails the start the same way: the explanation lists the contexts the kubeconfig actually has. A failed poll only logs to the OpenCode server log and retries on the next tick.

## Install

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:hrntknr/opencode-plugin-k8s"]
}
```

## Options

Options go in the object form of the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "github:hrntknr/opencode-plugin-k8s",
      "options": {
        "intervalMs": 60000,
        "context": "prod-cluster",
        "namespaces": ["default", "prod"],
        "labelSelector": "app.kubernetes.io/managed-by=helm"
      }
    }
  ]
}
```

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `intervalMs` | number | `30000` | Poll interval in milliseconds. |
| `context` | string | current context | Kubeconfig context the watch uses and pins at start. The `--context` flag and the `k8s_watch` tool's `context` parameter take precedence over this option. |
| `namespaces` | string[] | current context namespace | Restrict the watch to these namespaces. Namespaces the current user cannot list are skipped. |
| `allNamespaces` | boolean | `false` | Watch all namespaces (cluster scope), like `kubectl get deployments -A`. Takes precedence over `namespaces`. |
| `labelSelector` | string | none | Label selector applied to the Deployment list. |

## Usage

Run in the session that should investigate the failing Deployments:

```text
/k8s-watch
/k8s-watch --context <name>
/k8s-watch --context=<name>
/k8s-watch stop
```

The optional `--context` flag selects the kubeconfig context to watch; without it the current context is used.

### Agent usage

The model can also start and stop the watch itself with the `k8s_watch` tool; asking it to "watch the cluster" in a session is enough. The tool's optional `context` parameter selects the kubeconfig context, like the command's `--context` flag. The initial report of currently failing Deployments is returned as the tool result, and later failures are queued into the session as prompts, just like with the command.

## Development

```sh
npm install
npm test
npm run typecheck
```
