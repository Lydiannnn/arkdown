import { useEffect, useRef, useState } from 'react'
import { createEditIndicatorClient, type EditIndicatorClient } from './edit-indicator-client'
import type { EditIndicatorState } from './line-diff'

export interface EditIndicatorModel {
  lineStates: readonly EditIndicatorState[]
  status: 'idle' | 'computing' | 'ready' | 'failed'
  markdownVersion: number
  modelVersion: number
}

export interface EditIndicatorModelInput {
  documentKey: string
  openingMarkdown: string
  savedMarkdown: string
  currentMarkdown: string
  enabled: boolean
}

interface VersionState {
  documentKey: string
  openingMarkdown: string
  savedMarkdown: string
  currentMarkdown: string
  enabled: boolean
  markdownVersion: number
  modelVersion: number
  generation: number
}

interface ComputedState {
  generation: number
  documentKey: string | null
  markdownVersion: number
  modelVersion: number
  lineStates: readonly EditIndicatorState[]
  status: EditIndicatorModel['status']
}

export function useEditIndicatorModel(input: EditIndicatorModelInput): EditIndicatorModel {
  const versionRef = useRef<VersionState | null>(null)
  const previous = versionRef.current
  if (!previous) {
    versionRef.current = {
      ...input,
      markdownVersion: 1,
      modelVersion: 1,
      generation: 1,
    }
  } else {
    const markdownChanged = previous.documentKey !== input.documentKey
      || previous.currentMarkdown !== input.currentMarkdown
    const modelChanged = markdownChanged
      || previous.openingMarkdown !== input.openingMarkdown
      || previous.savedMarkdown !== input.savedMarkdown
    if (modelChanged || previous.enabled !== input.enabled) {
      versionRef.current = {
        ...input,
        markdownVersion: previous.markdownVersion + (markdownChanged ? 1 : 0),
        modelVersion: previous.modelVersion + (modelChanged ? 1 : 0),
        generation: previous.generation + 1,
      }
    }
  }
  const version = versionRef.current!
  const [computed, setComputed] = useState<ComputedState>({
    generation: 0,
    documentKey: null,
    markdownVersion: 0,
    modelVersion: 0,
    lineStates: [],
    status: 'idle',
  })
  const clientRef = useRef<EditIndicatorClient | null>(null)
  const activeRef = useRef(false)

  useEffect(() => {
    if (!input.enabled) return
    activeRef.current = true
    clientRef.current = createEditIndicatorClient()
    return () => {
      activeRef.current = false
      const client = clientRef.current
      clientRef.current = null
      client?.dispose()
    }
  }, [input.enabled])

  useEffect(() => {
    const generation = version.generation
    if (!version.enabled) {
      setComputed({
        generation,
        documentKey: null,
        markdownVersion: version.markdownVersion,
        modelVersion: version.modelVersion,
        lineStates: [],
        status: 'idle',
      })
      return
    }
    setComputed((current) => {
      const retain = current.documentKey === version.documentKey
      return {
        generation,
        documentKey: retain ? current.documentKey : null,
        markdownVersion: retain ? current.markdownVersion : version.markdownVersion,
        modelVersion: retain ? current.modelVersion : version.modelVersion,
        lineStates: retain ? current.lineStates : [],
        status: 'computing',
      }
    })
    let cancelled = false
    const timer = window.setTimeout(() => {
      const client = clientRef.current
      if (!client || !activeRef.current || cancelled) return
      void client.compute({
        documentKey: version.documentKey,
        openingMarkdown: version.openingMarkdown,
        savedMarkdown: version.savedMarkdown,
        currentMarkdown: version.currentMarkdown,
      }).then((snapshot) => {
        if (
          !snapshot
          || cancelled
          || !activeRef.current
          || versionRef.current?.generation !== generation
        ) return
        setComputed({
          generation,
          documentKey: version.documentKey,
          markdownVersion: version.markdownVersion,
          modelVersion: version.modelVersion,
          lineStates: snapshot.states,
          status: 'ready',
        })
      }).catch((error: unknown) => {
        if (
          cancelled
          || !activeRef.current
          || versionRef.current?.generation !== generation
        ) return
        console.error('edit-indicator-diff-failed', error)
        setComputed({
          generation,
          documentKey: null,
          markdownVersion: version.markdownVersion,
          modelVersion: version.modelVersion,
          lineStates: [],
          status: 'failed',
        })
      })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [version.generation])

  const retain = input.enabled && computed.documentKey === input.documentKey
  return {
    lineStates: retain ? computed.lineStates : [],
    status: !input.enabled ? 'idle' : computed.generation !== version.generation ? 'computing' : computed.status,
    markdownVersion: retain ? computed.markdownVersion : version.markdownVersion,
    modelVersion: retain ? computed.modelVersion : version.modelVersion,
  }
}
