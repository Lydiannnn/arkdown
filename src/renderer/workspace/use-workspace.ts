import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiResult, ArkdownApi, WorkspaceSummary } from '../../shared/contracts'

type WorkspaceResult = ApiResult<WorkspaceSummary | null>
type Coordinator = { restore: Promise<WorkspaceResult> | null; choose: Promise<WorkspaceResult> | null }

const coordinators = new WeakMap<ArkdownApi, Coordinator>()

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : '无法访问工作区。'
}

function coordinatorFor(api: ArkdownApi): Coordinator {
  let coordinator = coordinators.get(api)
  if (!coordinator) {
    coordinator = { restore: null, choose: null }
    coordinators.set(api, coordinator)
  }
  return coordinator
}

function clearWhenSettled<T>(promise: Promise<T>, clear: () => void) {
  void promise.then(clear, clear)
}

function restoreFor(api: ArkdownApi, coordinator: Coordinator): Promise<WorkspaceResult> {
  if (coordinator.choose) {
    return coordinator.choose.then(
      (result) => result.ok && result.value ? result : restoreFor(api, coordinator),
      () => restoreFor(api, coordinator),
    )
  }
  if (!coordinator.restore) {
    const promise = api.restoreWorkspace()
    coordinator.restore = promise
    clearWhenSettled(promise, () => { if (coordinator.restore === promise) coordinator.restore = null })
  }
  return coordinator.restore
}

function chooseFor(api: ArkdownApi, coordinator: Coordinator): Promise<WorkspaceResult> {
  if (!coordinator.choose) {
    const pendingRestore = coordinator.restore
    const promise = (async () => {
      if (pendingRestore) await pendingRestore.catch(() => undefined)
      return api.chooseWorkspace()
    })()
    coordinator.choose = promise
    clearWhenSettled(promise, () => { if (coordinator.choose === promise) coordinator.choose = null })
  }
  return coordinator.choose
}

export function useWorkspace(options: { restoreOnMount?: boolean } = {}) {
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null)
  const [authorityRevision, setAuthorityRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isChoosing, setIsChoosing] = useState(false)
  const requestVersion = useRef(0)
  const mounted = useRef(false)
  const api = window.arkdown

  const applyResult = useCallback((version: number, result: WorkspaceResult, keepCurrentOnNull: boolean) => {
    if (!mounted.current || version !== requestVersion.current) return
    if (result.ok) {
      if (result.value || !keepCurrentOnNull) {
        setWorkspace(result.value)
        setAuthorityRevision((current) => current + 1)
      }
      setError(null)
    } else setError(result.error.message)
  }, [])

  useEffect(() => {
    mounted.current = true
    if (options.restoreOnMount === false) {
      return () => { mounted.current = false }
    }
    const version = ++requestVersion.current
    const coordinator = coordinatorFor(api)
    void restoreFor(api, coordinator).then(
      (result) => applyResult(version, result, false),
      (error: unknown) => { if (mounted.current && version === requestVersion.current) setError(messageFor(error)) },
    )
    return () => { mounted.current = false }
  }, [api, applyResult, options.restoreOnMount])

  const adoptWorkspace = useCallback((nextWorkspace: WorkspaceSummary) => {
    requestVersion.current += 1
    setWorkspace(nextWorkspace)
    setAuthorityRevision((current) => current + 1)
    setError(null)
    setIsChoosing(false)
  }, [])

  const chooseWorkspace = useCallback(async () => {
    const version = ++requestVersion.current
    setError(null)
    setIsChoosing(true)
    try {
      applyResult(version, await chooseFor(api, coordinatorFor(api)), true)
    } catch (error) {
      if (mounted.current && version === requestVersion.current) setError(messageFor(error))
    } finally {
      if (mounted.current && version === requestVersion.current) setIsChoosing(false)
    }
  }, [api, applyResult])

  return { workspace, authorityRevision, chooseWorkspace, adoptWorkspace, error, isChoosing }
}
