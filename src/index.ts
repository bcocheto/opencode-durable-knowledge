import { Plugin } from "@opencode/plugin"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"

import { createCaptureTool, createTransientTool } from "./capture-tools.js"
import { ContextBridge, type SystemTextPart } from "./context-bridge.js"
import {
  IdleReview,
  type ReviewEvent,
  type ReviewMessage,
} from "./idle-review.js"
import { parseOptions } from "./options.js"

const plugin = Plugin.define({
  id: "bcocheto.durable-knowledge",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const bridge = new ContextBridge(options)
    const registrations: Array<{ dispose(): Promise<void> }> = []
    let idleReview: IdleReview | undefined

    try {
      registrations.push(
        await ctx.session.hook("prompt", async (event) => {
          if (bridge.isReviewPrompt(event.metadata)) return
          const session = await ctx.session.get({ sessionID: event.sessionID })
          await bridge.preparePrompt({
            sessionID: event.sessionID,
            messageID: event.messageID,
            prompt: event.prompt.text,
            directory: session.location.directory,
            ...(event.metadata ? { metadata: event.metadata } : {}),
          })
        }),
      )

      registrations.push(
        await ctx.session.hook("context", (event) => {
          bridge.appendContext(event.sessionID, event.system as SystemTextPart[])
        }),
      )

      const readSessionContext = async (sessionID: string) =>
        (await ctx.session.context({ sessionID })) as readonly ReviewMessage[]

      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.namespace({
            name: "durable_knowledge",
            description: "Verified access to durable Obsidian knowledge.",
          })
          editor.add(
            createCaptureTool(options, readSessionContext) as unknown as ToolInfo,
          )
          editor.add(
            createTransientTool(options, readSessionContext) as unknown as ToolInfo,
          )
        }),
      )

      idleReview = new IdleReview(options, {
        getSession: async (sessionID) => {
          const session = await ctx.session.get({ sessionID })
          return {
            ...(session.outcome ? { outcome: session.outcome } : {}),
            location: { directory: session.location.directory },
          }
        },
        getContext: readSessionContext,
        prompt: async (input) => {
          await ctx.session.prompt(
            input as Parameters<typeof ctx.session.prompt>[0],
          )
        },
        subscribe: (signal) => ({
          async *[Symbol.asyncIterator]() {
            for await (const event of ctx.event.subscribe({ signal })) {
              yield event as ReviewEvent
            }
          },
        }),
      })
    } catch (error) {
      await idleReview?.dispose()
      await Promise.allSettled(registrations.map((registration) => registration.dispose()))
      throw error
    }

    return async () => {
      await idleReview?.dispose()
      await Promise.allSettled(registrations.map((registration) => registration.dispose()))
    }
  },
})

export default plugin
