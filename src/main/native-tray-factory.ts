import { Tray, type NativeImage } from 'electron'
import { observeNativeTray } from './native-tray-observer'

export function createNativeTray(image: NativeImage | string): Tray {
  return observeNativeTray(new Tray(image))
}
