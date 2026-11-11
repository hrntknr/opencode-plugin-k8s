import { Plugin } from "@opencode/plugin"
import { ApiException, AppsV1Api, KubeConfig, type V1Deployment } from "@kubernetes/client-node"
import {
  badDeployments,
  describeNamespaces,
  diffBad,
  formatAlert,
  formatForbidden,
  formatIdleStatus,
  formatReasonChange,
  formatReport,
  formatStatus,
  formatUnknownContext,
  parseContextArg,
  reasonChanges,
  resolveWatchedNamespaces,
  type BadDeployment,
  type NamespaceOptions,
  type WatchedNamespaces,
} from "./lib.ts"

type Delivery = "steer" | "queue"

interface Options extends NamespaceOptions {
  intervalMs?: number
  labelSelector?: string
  context?: string
}

type PinnedContext = {
  context: string
  namespaces: WatchedNamespaces
}

type UnknownContext = {
  unknownContext: string
  contexts: string[]
}

type WatchState = {
  sessionID: string
  bad: Record<string, BadDeployment>
  context: string
  namespaces: WatchedNamespaces
}

type LegacyWatchState = {
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

const isForbidden = (error: unknown): boolean => error instanceof ApiException && error.code === 403

export default Plugin.define({
  id: "k8s",
  async setup(ctx) {
    const options = ctx.options as Options
    const intervalMs = options.intervalMs ?? 30_000

    let timer: ReturnType<typeof setInterval> | undefined
    let state: WatchState | undefined

    const resolvePinnedContext = (requested: string | undefined): PinnedContext | UnknownContext => {
      const kubeConfig = new KubeConfig()
      kubeConfig.loadFromDefault()
      const contexts = kubeConfig.getContexts().map((context) => context.name)
      const context = requested ?? options.context ?? kubeConfig.getCurrentContext()
      if (!contexts.includes(context)) return { unknownContext: context, contexts }
      return { context, namespaces: resolveWatchedNamespaces(options, kubeConfig.getContextObject(context)?.namespace) }
    }

    const listDeployments = async (pinned: PinnedContext): Promise<ListResult> => {
      const kubeConfig = new KubeConfig()
      kubeConfig.loadFromDefault()
      kubeConfig.setCurrentContext(pinned.context)
      const api = kubeConfig.makeApiClient(AppsV1Api)
      const namespaces = pinned.namespaces
      if ("all" in namespaces) {
        try {
          const list = await api.listDeploymentForAllNamespaces({ labelSelector: options.labelSelector })
          return { deployments: list.items, watched: describeNamespaces(namespaces), skipped: [] }
        } catch (error) {
          if (!isForbidden(error)) throw error
          return { deployments: [], watched: "", skipped: [], blocked: describeNamespaces(namespaces) }
        }
      }
      const results = await Promise.allSettled(
        namespaces.namespaces.map((namespace) => api.listNamespacedDeployment({ namespace, labelSelector: options.labelSelector })),
      )
      const deployments: V1Deployment[] = []
      const skipped: string[] = []
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") deployments.push(...result.value.items)
        else if (isForbidden(result.reason)) skipped.push(namespaces.namespaces[index])
        else throw result.reason
      }
      const accessible = namespaces.namespaces.filter((namespace) => !skipped.includes(namespace))
      if (accessible.length === 0) return { deployments, watched: "", skipped, blocked: describeNamespaces(namespaces) }
      return { deployments, watched: describeNamespaces({ namespaces: accessible }), skipped }
    }

    const kick = (sessionID: string, text: string, delivery: Delivery) => ctx.session.prompt({ sessionID, text, delivery })

    const sync = async (current: Map<string, BadDeployment>) => {
      if (!state) return
      const previous = new Map(Object.entries(state.bad))
      for (const deployment of diffBad(current, previous)) {
        await kick(state.sessionID, formatAlert(deployment), "queue")
      }
      for (const change of reasonChanges(current, previous)) {
        await kick(state.sessionID, formatReasonChange(change), "queue")
      }
      state = { ...state, bad: Object.fromEntries(current) }
      await ctx.storage.set(WATCH_KEY, state)
    }

    const poll = async () => {
      if (!state) return
      try {
        const { deployments } = await listDeployments(state)
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

    const startWatch = async (sessionID: string, requested: string | undefined): Promise<string> => {
      clearInterval(timer)
      let pinned: PinnedContext
      let result: ListResult
      try {
        const resolution = resolvePinnedContext(requested)
        if ("unknownContext" in resolution) {
          await disarm()
          return formatUnknownContext(resolution.unknownContext, resolution.contexts)
        }
        pinned = resolution
        result = await listDeployments(pinned)
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
      state = { sessionID, bad: Object.fromEntries(current), context: pinned.context, namespaces: pinned.namespaces }
      await ctx.storage.set(WATCH_KEY, state)
      arm()
      return formatReport([...current.values()], { context: pinned.context, watched: result.watched, skipped: result.skipped })
    }

    const upgradeLegacy = async (stored: LegacyWatchState): Promise<void> => {
      try {
        const pinned = resolvePinnedContext(undefined)
        if ("unknownContext" in pinned) {
          await disarm()
          return
        }
        state = { ...stored, ...pinned }
        await ctx.storage.set(WATCH_KEY, state)
      } catch (error) {
        console.error("k8s-watch: resuming the stored watch failed", error)
      }
    }

    const statusText = (): string => {
      if (!state) return formatIdleStatus()
      return formatStatus(Object.values(state.bad), {
        context: state.context,
        watched: describeNamespaces(state.namespaces),
        intervalMs,
      })
    }

    const commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        name: "k8s-watch",
        description:
          "Watch Kubernetes Deployments for failures and report them in this session. Stop the watch with: stop. Show the watch status with: status",
        execute: async ({ sessionID, prompt, delivery }) => {
          if (/\bstop\b/i.test(prompt.text)) {
            await disarm()
            await kick(sessionID, STOP_MESSAGE, delivery)
            return
          }
          if (/\bstatus\b/i.test(prompt.text)) {
            await kick(sessionID, statusText(), delivery)
            return
          }
          await kick(sessionID, await startWatch(sessionID, parseContextArg(prompt.text)), delivery)
        },
      })
    })

    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.namespace({ name: "k8s", description: "Watch Kubernetes Deployments for failures" })
      editor.add({
        name: "watch",
        description:
          "Watch Kubernetes Deployments for failures in this session. Use action=start to begin reporting newly failing Deployments here (returns the currently failing ones); action=stop to stop the watch. Pass context to name the kubeconfig context to watch; without it the kubeconfig current context is used. Use action=status to see what is being watched and what is currently failing.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["start", "stop", "status"] },
            context: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "k8s" },
        execute: async (input, context) => {
          const { action, context: requested } = input as { action: "start" | "stop" | "status"; context?: string }
          if (action === "stop") {
            await disarm()
            return { content: STOP_MESSAGE }
          }
          if (action === "status") return { content: statusText() }
          return { content: await startWatch(context.sessionID, requested) }
        },
      })
    })

    const stored = (await ctx.storage.get(WATCH_KEY)) as WatchState | LegacyWatchState | undefined
    if (stored) {
      if ("context" in stored) state = stored
      else await upgradeLegacy(stored)
      if (state) arm()
    }

    return async () => {
      clearInterval(timer)
      await commandRegistration.dispose()
      await toolRegistration.dispose()
    }
  },
})
