import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as z from 'zod'

import { computerUseToolDefinitions } from '../../src/main/ai/tools/computerUse'

const directory = fileURLToPath(new URL('backend/generated/', import.meta.url))
mkdirSync(directory, { recursive: true })
writeFileSync(
  `${directory}/computer-tools.json`,
  JSON.stringify(
    computerUseToolDefinitions
      // The pinned helper cannot reliably route background keys to the focused child control.
      .filter(({ name }) => name !== 'press_key')
      .map(({ name, description, inputSchema }) => ({
        type: 'function',
        function: {
          name: `mcp__computer__${name}`,
          description,
          parameters: z.toJSONSchema(inputSchema, { io: 'input' })
        }
      }))
  )
)
