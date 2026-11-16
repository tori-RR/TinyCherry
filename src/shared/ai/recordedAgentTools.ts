/** Structural DTOs for rendering recorded tool messages. Based on Claude SDK 0.3.311 tool JSON schemas; no runtime or executable dependency. */
export interface AgentInput {
  description: string
  prompt: string
  subagent_type?: string
  model?: 'sonnet' | 'opus' | 'haiku' | 'fable'
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  run_in_background?: boolean
  name?: string
  team_name?: string
  mode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan'
  isolation?: 'worktree' | 'remote'
}
export type AgentOutput =
  | {
      agentId: string
      agentType?: string
      content: {
        type: 'text'
        text: string
        citations?: unknown[] | null
      }[]
      resolvedModel?: string
      modelsUsed?: string[]
      totalToolUseCount: number
      totalDurationMs: number
      totalTokens: number
      usage: {
        input_tokens: number
        output_tokens: number
        cache_creation_input_tokens: number | null
        cache_read_input_tokens: number | null
        server_tool_use: {
          web_search_requests: number
          web_fetch_requests: number
        } | null
        service_tier: string | null
        cache_creation: {
          ephemeral_1h_input_tokens: number
          ephemeral_5m_input_tokens: number
        } | null
        inference_geo?: string | null
        speed?: string | null
        iterations?: unknown
        output_tokens_details?: {
          thinking_tokens?: number | null
        } | null
        fallback_credit?: unknown
      }
      toolsUsed?: string[]
      toolStats?: {
        readCount: number
        searchCount: number
        bashCount: number
        editFileCount: number
        linesAdded: number
        linesRemoved: number
        otherToolCount: number
        frameCount?: number
      }
      status: 'completed'
      prompt: string
      worktreePath?: string
      worktreeBranch?: string
    }
  | {
      status: 'async_launched'
      isAsync?: true
      agentId: string
      description: string
      resolvedModel?: string
      modelsUsed?: string[]
      prompt: string
      outputFile: string
      canReadOutputFile?: boolean
    }
  | {
      status: 'remote_launched'
      taskId: string
      sessionUrl: string
      description: string
      prompt: string
      outputFile: string
    }
export interface AskUserQuestionInput {
  questions:
    | [
        {
          question: string
          header: string
          options:
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
          multiSelect: boolean
        }
      ]
    | [
        {
          question: string
          header: string
          options:
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
          multiSelect: boolean
        },
        {
          question: string
          header: string
          options:
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
          multiSelect: boolean
        }
      ]
    | [
        {
          question: string
          header: string
          options:
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
          multiSelect: boolean
        },
        {
          question: string
          header: string
          options:
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
          multiSelect: boolean
        },
        {
          question: string
          header: string
          options:
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
          multiSelect: boolean
        }
      ]
    | [
        {
          question: string
          header: string
          options:
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
          multiSelect: boolean
        },
        {
          question: string
          header: string
          options:
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
          multiSelect: boolean
        },
        {
          question: string
          header: string
          options:
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
          multiSelect: boolean
        },
        {
          question: string
          header: string
          options:
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
            | [
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                },
                {
                  label: string
                  description: string
                  preview?: string
                }
              ]
          multiSelect: boolean
        }
      ]
  answers?: {
    [k: string]: string
  }
  annotations?: {
    [k: string]: {
      preview?: string
      notes?: string
    }
  }
  metadata?: {
    source?: string
  }
}
export interface AskUserQuestionOutput {
  questions: {
    question: string
    header: string
    options:
      | [
          {
            label: string
            description: string
            preview?: string
          },
          {
            label: string
            description: string
            preview?: string
          }
        ]
      | [
          {
            label: string
            description: string
            preview?: string
          },
          {
            label: string
            description: string
            preview?: string
          },
          {
            label: string
            description: string
            preview?: string
          }
        ]
      | [
          {
            label: string
            description: string
            preview?: string
          },
          {
            label: string
            description: string
            preview?: string
          },
          {
            label: string
            description: string
            preview?: string
          },
          {
            label: string
            description: string
            preview?: string
          }
        ]
    multiSelect: boolean
  }[]
  answers: {
    [k: string]: string
  }
  response?: string
  annotations?: {
    [k: string]: {
      preview?: string
      notes?: string
    }
  }
  afkTimeoutMs?: number
}
export interface BashInput {
  command: string
  timeout?: number
  description?: string
  run_in_background?: boolean
  dangerouslyDisableSandbox?: boolean
}
export interface BashOutput {
  stdout: string
  stderr: string
  rawOutputPath?: string
  interrupted: boolean
  isImage?: boolean
  backgroundTaskId?: string
  backgroundedByUser?: boolean
  timedOutAfterMs?: number
  backgroundCwdHint?: string
  backgroundEndsWithFinalResponse?: true
  dangerouslyDisableSandbox?: boolean
  returnCodeInterpretation?: string
  noOutputExpected?: boolean
  structuredContent?: unknown[]
  persistedOutputPath?: string
  persistedOutputSize?: number
  staleReadFileStateHint?: string
  ghRateLimitHint?: string
  gitOperation?: {
    commit?: {
      sha: string
      kind: 'committed' | 'amended' | 'cherry-picked'
      branch?: string
    }
    push?: {
      branch: string
    }
    branch?: {
      ref: string
      action: 'merged' | 'rebased'
    }
    pr?: {
      number: number
      url?: string
      action:
        | 'created'
        | 'edited'
        | 'merged'
        | 'commented'
        | 'closed'
        | 'reopened'
        | 'ready'
        | 'draft'
        | 'auto-merge-enabled'
        | 'auto-merge-disabled'
    }
  }
}
export interface EnterWorktreeInput {
  name?: string
  path?: string
}
export interface EnterWorktreeOutput {
  worktreePath: string
  worktreeBranch?: string
  message: string
}
export interface ExitPlanModeInput {
  allowedPrompts?: {
    tool: 'Bash'
    prompt: string
  }[]
  [k: string]: unknown
}
export interface ExitPlanModeOutput {
  plan: string | null
  isAgent: boolean
  filePath?: string
  hasTaskTool?: boolean
  planWasEdited?: boolean
  awaitingLeaderApproval?: boolean
  requestId?: string
}
export interface ExitWorktreeInput {
  action: 'keep' | 'remove'
  discard_changes?: boolean
}
export interface ExitWorktreeOutput {
  action: 'keep' | 'remove'
  originalCwd: string
  worktreePath: string
  worktreeBranch?: string
  tmuxSessionName?: string
  discardedFiles?: number
  discardedCommits?: number
  message: string
}
export interface FileEditInput {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}
export interface FileEditOutput {
  filePath: string
  oldString: string
  newString: string
  originalFile: string | null
  structuredPatch: {
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }[]
  userModified: boolean
  replaceAll: boolean
  gitDiff?: {
    filename: string
    status: 'modified' | 'added'
    additions: number
    deletions: number
    changes: number
    patch: string
    repository?: string | null
  }
  staged?: boolean
}
export interface FileReadInput {
  file_path: string
  offset?: number
  limit?: number
  pages?: string
  allow_large?: boolean
}
export type FileReadOutput =
  | {
      type: 'text'
      file: {
        filePath: string
        content: string
        numLines: number
        startLine: number
        totalLines: number
        truncatedByTokenCap?: boolean
      }
      artifactRead?: {
        slug: string
        ver: string
      }
    }
  | {
      type: 'image'
      file: {
        base64: string
        type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
        originalSize: number
        dimensions?: {
          originalWidth?: number
          originalHeight?: number
          displayWidth?: number
          displayHeight?: number
        }
      }
    }
  | {
      type: 'notebook'
      file: {
        filePath: string
        cells: unknown[]
      }
    }
  | {
      type: 'pdf'
      file: {
        filePath: string
        base64: string
        originalSize: number
      }
    }
  | {
      type: 'parts'
      file: {
        filePath: string
        originalSize: number
        count: number
        outputDir: string
      }
      firstPage?: number
      pages?: {
        base64: string
        mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
        error?: string
      }[]
    }
  | {
      type: 'file_unchanged'
      file: {
        filePath: string
      }
      source?: 'seeded'
    }
export interface FileWriteInput {
  file_path: string
  content: string
}
export interface FileWriteOutput {
  type: 'create' | 'update'
  filePath: string
  content: string
  structuredPatch: {
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }[]
  originalFile: string | null
  gitDiff?: {
    filename: string
    status: 'modified' | 'added'
    additions: number
    deletions: number
    changes: number
    patch: string
    repository?: string | null
  }
  userModified?: boolean
  staged?: boolean
}
export interface GlobInput {
  pattern: string
  path?: string
}
export interface GlobOutput {
  durationMs: number
  numFiles: number
  filenames: string[]
  truncated: boolean
  totalMatches?: number
  countIsComplete?: boolean
}
export interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-B'?: number
  '-A'?: number
  '-C'?: number
  context?: number
  '-n'?: boolean
  '-i'?: boolean
  '-o'?: boolean
  type?: string
  head_limit?: number
  offset?: number
  multiline?: boolean
}
export interface GrepOutput {
  mode?: 'content' | 'files_with_matches' | 'count'
  numFiles: number
  filenames: string[]
  content?: string
  numLines?: number
  numMatches?: number
  totalFiles?: number
  totalLines?: number
  appliedLimit?: number
  appliedOffset?: number
}
export interface ListMcpResourcesInput {
  server?: string
}
export type ListMcpResourcesOutput = {
  uri: string
  name: string
  mimeType?: string
  description?: string
  server: string
}[]
export interface NotebookEditInput {
  notebook_path: string
  cell_id?: string
  new_source: string
  cell_type?: 'code' | 'markdown'
  edit_mode?: 'replace' | 'insert' | 'delete'
}
export interface NotebookEditOutput {
  new_source: string
  old_source?: string
  cell_id?: string
  cell_type: 'code' | 'markdown'
  language: string
  edit_mode: string
  error?: string
  notebook_path: string
  original_file: string
  updated_file: string
}
export interface ReadMcpResourceInput {
  server: string
  uri: string
}
export interface ReadMcpResourceOutput {
  contents: {
    uri: string
    mimeType?: string
    text?: string
    blobSavedTo?: string
  }[]
  error?: string
}
export interface TaskCreateInput {
  subject: string
  description: string
  activeForm?: string
  metadata?: {
    [k: string]: unknown
  }
}
export interface TaskCreateOutput {
  task: {
    id: string
    subject: string
  }
}
export interface TaskGetInput {
  taskId: string
}
export interface TaskGetOutput {
  task: {
    id: string
    subject: string
    description: string
    status: 'pending' | 'in_progress' | 'completed'
    blocks: string[]
    blockedBy: string[]
  } | null
}
export interface TaskListInput {}
export interface TaskListOutput {
  tasks: {
    id: string
    subject: string
    status: 'pending' | 'in_progress' | 'completed'
    owner?: string
    blockedBy: string[]
  }[]
}
export interface TaskStopInput {
  task_id?: string
  shell_id?: string
}
export interface TaskStopOutput {
  message: string
  task_id: string
  task_type: string
  command?: string
}
export interface TaskUpdateInput {
  taskId: string
  subject?: string
  description?: string
  activeForm?: string
  status?: ('pending' | 'in_progress' | 'completed') | 'deleted'
  addBlocks?: string[]
  addBlockedBy?: string[]
  owner?: string
  metadata?: {
    [k: string]: unknown
  }
}
export interface TaskUpdateOutput {
  success: boolean
  taskId: string
  updatedFields: string[]
  error?: string
  statusChange?: {
    from: string
    to: string
  }
}
export interface TodoWriteInput {
  todos: {
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    activeForm: string
  }[]
}
export interface TodoWriteOutput {
  oldTodos: {
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    activeForm: string
  }[]
  newTodos: {
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    activeForm: string
  }[]
}
export interface WebFetchInput {
  url: string
  prompt: string
  offset?: number
}
export interface WebFetchOutput {
  bytes: number
  code: number
  codeText: string
  result: string
  durationMs: number
  url: string
  artifactRead?: {
    slug: string
    ver?: string
    seeded?: false
  }
}
export interface WebSearchInput {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}
export interface WebSearchOutput {
  query: string
  results: (
    | {
        tool_use_id: string
        content: {
          title: string
          url: string
          snippet?: string
        }[]
      }
    | string
  )[]
  durationSeconds: number
  searchCount?: number
}
export interface WorkflowInput {
  script?: string
  name?: string
  description?: string
  title?: string
  args?: {
    [k: string]: unknown
  }
  scriptPath?: string
  resumeFromRunId?: string
}
export interface WorkflowOutput {
  status: 'async_launched' | 'remote_launched'
  taskId: string
  taskType?: 'local_workflow' | 'remote_agent'
  workflowName?: string
  runId?: string
  summary?: string
  transcriptDir?: string
  scriptPath?: string
  sessionUrl?: string
  warning?: string
  error?: string
}
