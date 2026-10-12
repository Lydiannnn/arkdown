export interface NativeTrayLifecycleObserver {
  created(): void
  destroyed(): void
}

export interface ObservableNativeTray {
  destroy(): void
  isDestroyed(): boolean
}

const NOOP_OBSERVER: NativeTrayLifecycleObserver = {
  created: () => undefined,
  destroyed: () => undefined,
}

let nativeTrayObserver = NOOP_OBSERVER

export function configureNativeTrayObserver(observer: NativeTrayLifecycleObserver): void {
  nativeTrayObserver = observer
}

export function observeNativeTray<T extends ObservableNativeTray>(tray: T): T {
  const observer = nativeTrayObserver
  let destroyReported = false
  observer.created()
  return new Proxy(tray, {
    get(target, property, receiver) {
      if (property === 'destroy') {
        return () => {
          if (target.isDestroyed()) return
          target.destroy()
          if (!destroyReported) {
            destroyReported = true
            observer.destroyed()
          }
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
