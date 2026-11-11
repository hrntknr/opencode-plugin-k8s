import { Plugin } from "@opencode/plugin"
import { ApiException, AppsV1Api, KubeConfig, type V1Deployment } from "@kubernetes/client-node"
import {
  badDeployments,
  describeNamespaces,
  diffBad,
  formatAlert,
  formatForbidden,
  formatReport,
  resolveWatchedNamespaces,
  type BadDeployment,
  type NamespaceOptions,
} from "./lib.ts"

type Delivery = "steer" | "queue"

interface Options extends NamespaceOptions {
  intervalMs?: number
  labelSelector?: string
}

type WatchState = {
  sessionID: string
  bad: Record<string, BadDeployment>
}

type ListResult = {
  deployments: V1Deployment[]
  watched: string
  skipped: string[]
  blocked?: string
}

const WATCH_KEY = "watch"
const STOP_MESSAGE = "k8s-watch stopped. Failing Deployments are no longer reported."

const contextNamespace = (kubeConfig: KubeConfig) => kubeConfig.getContextObject(kubeConfig.getCurrentContext())?.namespace

const isForbidden = (error: unknown): boolean => error instanceof ApiException && error.code === 403

export default Plugin.define({
  id: "k8s",
  async setup(ctx) {
    const options = ctx.options as Options
    const intervalMs = options.intervalMs ?? 30_000

    let timer: ReturnType<typeof setInterval> | undefined
    let state: WatchState | undefined

    const listDeployments = async (): Promise<ListResult> => {
      const kubeConfig = new KubeConfig()
      kubeConfig.loadFromDefault()
      const api = kubeConfig.makeApiClient(AppsV1Api)
      const targets = resolveWatchedNamespaces(options, contextNamespace(kubeConfig))
      if ("all" in targets) {
        try {
          const list = await api.listDeploymentForAllNamespaces({ labelSelector: options.labelSelector })
          return { deployments: list.items, watched: describeNamespaces(targets), skipped: [] }
        } catch (error) {
          if (!isForbidden(error)) throw error
          return { deployments: [], watched: "", skipped: [], blocked: describeNamespaces(targets) }
        }
      }
      const results = await Promise.allSettled(
        targets.namespaces.map((namespace) => api.listNamespacedDeployment({ namespace, labelSelector: options.labelSelector })),
      )
      const deployments: V1Deployment[] = []
      const skipped: string[] = []
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") deployments.push(...result.value.items)
        else if (isForbidden(result.reason)) skipped.push(targets.namespaces[index])
        else throw result.reason
      }
      const accessible = targets.namespaces.filter((namespace) => !skipped.includes(namespace))
      if (accessible.length === 0) return { deployments, watched: "", skipped, blocked: describeNamespaces(targets) }
      return { deployments, watched: describeNamespaces({ namespaces: accessible }), skipped }
    }

    const kick = (sessionID: string, text: string, delivery: Delivery) => ctx.session.prompt({ sessionID, text, delivery })

    const sync = async (current: Map<string, BadDeployment>) => {
      if (!state) return
      for (const deployment of diffBad(current, new Map(Object.entries(state.bad)))) {
        await kick(state.sessionID, formatAlert(deployment), "queue")
      }
      state = { sessionID: state.sessionID, bad: Object.fromEntries(current) }
      await ctx.storage.set(WATCH_KEY, state)
    }

    const poll = async () => {
      if (!state) return
      try {
        const { deployments } = await listDeployments()
        await sync(badDeployments(deployments))
      } catch (error) {
        console.error("k8s-watch: polling deployments failed", error)
      }
    }

    const arm = () => {
      clearInterval(timer)
      timer = setInterval(() => void poll(), intervalMs)
    }

    const disarm = async () => {
      clearInterval(timer)
      timer = undefined
      state = undefined
      await ctx.storage.remove(WATCH_KEY)
    }

    const startWatch = async (sessionID: string): Promise<string> => {
      clearInterval(timer)
      let result: ListResult
      try {
        result = await listDeployments()
      } catch (error) {
        console.error("k8s-watch: listing deployments failed", error)
        await disarm()
        const message = error instanceof Error ? error.message : String(error)
        return `k8s-watch could not list deployments: ${message}. Check that kubectl reaches your cluster (for example with \`kubectl get deployments\`), then start the watch again.`
      }
      if (result.blocked !== undefined) {
        await disarm()
        return formatForbidden(result.blocked)
      }
      const current = badDeployments(result.deployments)
      state = { sessionID, bad: Object.fromEntries(current) }
      await ctx.storage.set(WATCH_KEY, state)
      arm()
      return formatReport([...current.values()], { watched: result.watched, skipped: result.skipped })
    }

    const commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        name: "k8s-watch",
        description: "Watch Kubernetes Deployments for failures and report them in this session. Stop the watch with: stop",
        execute: async ({ sessionID, prompt, delivery }) => {
          if (/\bstop\b/i.test(prompt.text)) {
            await disarm()
            await kick(sessionID, STOP_MESSAGE, delivery)
            return
          }
          await kick(sessionID, await startWatch(sessionID), delivery)
        },
      })
    })

    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.namespace({ name: "k8s", description: "Watch Kubernetes Deployments for failures" })
      editor.add({
        name: "watch",
        description:
          "Watch Kubernetes Deployments for failures in this session. Use action=start to begin reporting newly failing Deployments here (returns the currently failing ones); action=stop to stop the watch.",
        input: {
          type: "object",
          properties: { action: { type: "string", enum: ["start", "stop"] } },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "k8s" },
        execute: async (input, context) => {
          const { action } = input as { action: "start" | "stop" }
          if (action === "stop") {
            await disarm()
            return { content: STOP_MESSAGE }
          }
          return { content: await startWatch(context.sessionID) }
        },
      })
    })

    const stored = (await ctx.storage.get(WATCH_KEY)) as WatchState | undefined
    if (stored) {
      state = stored
      arm()
    }

    return async () => {
      clearInterval(timer)
      await commandRegistration.dispose()
      await toolRegistration.dispose()
    }
  },
})
