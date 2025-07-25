// eslint-disable consistent-type-definitions
import { z } from '@bpinternal/zui'

import { ZaiContext } from '../context'
import { Response } from '../response'
import { getTokenizer } from '../tokenizer'
import { fastHash, stringify, takeUntilTokens } from '../utils'
import { Zai } from '../zai'
import { PROMPT_INPUT_BUFFER } from './constants'

const _Example = z.object({
  input: z.any(),
  check: z.boolean(),
  reason: z.string().optional(),
  condition: z.string().optional(),
})

type Example = {
  input: unknown
  check: boolean
  reason?: string
  condition?: string
}

export type Options = {
  /** Examples to check the condition against */
  examples?: Array<Example>
}

const _Options = z.object({
  examples: z.array(_Example).describe('Examples to check the condition against').default([]),
})

declare module '@botpress/zai' {
  interface Zai {
    /** Checks wether a condition is true or not */
    check(
      input: unknown,
      condition: string,
      options?: Options
    ): Response<
      {
        /** Whether the condition is true or not */
        value: boolean
        /** The explanation of the decision */
        explanation: string
      },
      boolean
    >
  }
}

const TRUE = '■TRUE■'
const FALSE = '■FALSE■'
const END = '■END■'

const check = async (
  input: unknown,
  condition: string,
  options: Options,
  ctx: ZaiContext
): Promise<{
  value: boolean
  explanation: string
}> => {
  ctx.controller.signal.throwIfAborted()
  const tokenizer = await getTokenizer()
  const model = await ctx.getModel()
  const PROMPT_COMPONENT = Math.max(model.input.maxTokens - PROMPT_INPUT_BUFFER, 100)

  const taskId = ctx.taskId
  const taskType = 'zai.check'

  const PROMPT_TOKENS = {
    INPUT: Math.floor(0.5 * PROMPT_COMPONENT),
    CONDITION: Math.floor(0.2 * PROMPT_COMPONENT),
  }

  // Truncate the input to fit the model's input size
  const inputAsString = tokenizer.truncate(stringify(input), PROMPT_TOKENS.INPUT)
  condition = tokenizer.truncate(condition, PROMPT_TOKENS.CONDITION)

  // All tokens remaining after the input and condition are accounted can be used for examples
  const EXAMPLES_TOKENS = PROMPT_COMPONENT - tokenizer.count(inputAsString) - tokenizer.count(condition)

  const Key = fastHash(
    JSON.stringify({
      taskType,
      taskId,
      input: inputAsString,
      condition,
    })
  )

  const examples =
    taskId && ctx.adapter
      ? await ctx.adapter.getExamples<string, boolean>({
          input: inputAsString,
          taskType,
          taskId,
        })
      : []

  const exactMatch = examples.find((x) => x.key === Key)
  if (exactMatch) {
    return { explanation: exactMatch.explanation ?? '', value: exactMatch.output }
  }

  const defaultExamples = [
    {
      input: '50 Cent',
      check: true,
      reason: '50 Cent is widely recognized as a public personality.',
      condition: 'Is the input a public personality?',
    },
    {
      input: ['apple', 'banana', 'carrot', 'house'],
      check: false,
      reason:
        'The list contains a house, which is not a fruit. Also, the list contains a carrot, which is a vegetable.',
      condition: 'Is the input exclusively a list of fruits?',
    },
  ] satisfies Example[]

  const userExamples = [
    ...examples.map((e) => ({ input: e.input, check: e.output, reason: e.explanation })),
    ...options.examples,
  ]

  let exampleId = 1

  const formatInput = (input: string, condition: string) => {
    const header = userExamples.length ? `Expert Example #${exampleId++}` : `Example of condition: "${condition}"`

    return `
${header}
<|start_input|>
${input.trim()}
<|end_input|>
`.trim()
  }

  const formatOutput = (answer: boolean, justification: string) => {
    return `
Analysis: ${justification}
Final Answer: ${answer ? TRUE : FALSE}
${END}
`.trim()
  }

  const formatExample = (example: Example) => [
    {
      type: 'text' as const,
      content: formatInput(stringify(example.input ?? null), example.condition ?? condition),
      role: 'user' as const,
    },
    {
      type: 'text' as const,
      content: formatOutput(example.check, example.reason ?? ''),
      role: 'assistant' as const,
    },
  ]

  const allExamples = takeUntilTokens(
    userExamples.length ? userExamples : defaultExamples,
    EXAMPLES_TOKENS,
    (el) => tokenizer.count(stringify(el.input)) + tokenizer.count(el.reason ?? '')
  )
    .map(formatExample)
    .flat()

  const specialInstructions = userExamples.length
    ? `
- You have been provided with examples from previous experts. Make sure to read them carefully before making your decision.
- Make sure to refer to the examples provided by the experts to justify your decision (when applicable).
- When in doubt, ground your decision on the examples provided by the experts instead of your own intuition.
- When no example is similar to the input, make sure to provide a clear justification for your decision while inferring the decision-making process from the examples provided by the experts.
`.trim()
    : ''

  const {
    extracted: { finalAnswer, explanation },
    meta,
  } = await ctx.generateContent({
    systemPrompt: `
Check if the following condition is true or false for the given input. Before answering, make sure to read the input and the condition carefully.
Justify your answer, then answer with either ${TRUE} or ${FALSE} at the very end, then add ${END} to finish the response.
IMPORTANT: Make sure to answer with either ${TRUE} or ${FALSE} at the end of your response, but NOT both.
---
Expert Examples (#1 to #${exampleId - 1}):
${specialInstructions}
`.trim(),
    stopSequences: [END],
    messages: [
      ...allExamples,
      {
        type: 'text',
        content: `
Considering the below input and above examples, is the following condition true or false?
${formatInput(inputAsString, condition)}
In your "Analysis", please refer to the Expert Examples # to justify your decision.`.trim(),
        role: 'user',
      },
    ],
    transform: (text) => {
      const hasTrue = text.includes(TRUE)
      const hasFalse = text.includes(FALSE)

      if (!hasTrue && !hasFalse) {
        throw new Error(`The model did not return a valid answer. The response was: ${text}`)
      }

      let finalAnswer: boolean
      const explanation = text
        .replace(TRUE, '')
        .replace(FALSE, '')
        .replace(END, '')
        .replace('Final Answer:', '')
        .replace('Analysis:', '')
        .trim()

      if (hasTrue && hasFalse) {
        // If both TRUE and FALSE are present, we need to check which one was answered last
        finalAnswer = text.lastIndexOf(TRUE) > text.lastIndexOf(FALSE)
      } else {
        finalAnswer = hasTrue
      }

      return { finalAnswer, explanation: explanation.trim() }
    },
  })

  if (taskId && ctx.adapter && !ctx.controller.signal.aborted) {
    await ctx.adapter.saveExample({
      key: Key,
      taskType,
      taskId,
      input: inputAsString,
      instructions: condition,
      metadata: {
        cost: {
          input: meta.cost.input,
          output: meta.cost.output,
        },
        latency: meta.latency,
        model: ctx.modelId,
        tokens: {
          input: meta.tokens.input,
          output: meta.tokens.output,
        },
      },
      output: finalAnswer,
      explanation,
    })
  }

  return {
    value: finalAnswer,
    explanation: explanation.trim(),
  }
}

Zai.prototype.check = function (
  this: Zai,
  input: unknown,
  condition: string,
  _options: Options | undefined
): Response<
  {
    value: boolean
    explanation: string
  },
  boolean
> {
  const options = _Options.parse(_options ?? {}) as Options

  const context = new ZaiContext({
    client: this.client,
    modelId: this.Model,
    taskId: this.taskId,
    taskType: 'zai.check',
    adapter: this.adapter,
  })

  return new Response<
    {
      value: boolean
      explanation: string
    },
    boolean
  >(context, check(input, condition, options, context), (result) => result.value)
}
