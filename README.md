# opencode-plugin-k8s

`opencode-plugin-k8s` is an OpenCode plugin that watches Kubernetes Deployments and reports failing ones in the OpenCode session that started the watch.

## Watch Model

Run `/k8s-watch` in a session to start watching. The plugin:

- lists Deployments through the Kubernetes API, using the default kubeconfig locations (same lookup as `kubectl`),
- treats a Deployment as failing when its `Available` condition is `False`, its `Progressing` condition is `False` with reason `ProgressDeadlineExceeded`, or its `ReplicaFailure` condition is `True`,
- injects an initial report of the currently failing Deployments into the starting session,
- re-lists the Deployments on every poll and injects a prompt for each newly failing Deployment with `delivery: "queue"`, so the agent investigates it without interrupting an in-flight turn,
- keeps the failing set in plugin storage, so a plugin reload resumes the watch without re-reporting already known failures.

Deployments that recover leave the failing set silently; if the same Deployment fails again later, it is reported again.

Run `/k8s-watch stop` to clear the timer and the stored watch state. Running `/k8s-watch` again replaces an active watch. If listing fails before the watch starts (for example no reachable cluster), the session gets one prompt explaining the failure and the watch does not start. A failed poll only logs to the OpenCode server log and retries on the next tick.

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
| `namespaces` | string[] | all namespaces | Restrict the watch to these namespaces. |
| `labelSelector` | string | none | Label selector applied to the Deployment list. |

## Usage

Run in the session that should investigate the failing Deployments:

```text
/k8s-watch
/k8s-watch stop
```

### Agent usage

The model can also start and stop the watch itself with the `k8s_watch` tool; asking it to "watch the cluster" in a session is enough. The initial report of currently failing Deployments is returned as the tool result, and later failures are queued into the session as prompts, just like with the command.

## Development

```sh
npm install
npm test
npm run typecheck
```
