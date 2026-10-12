export class UpdatePackageInvalidError extends Error {
  constructor() { super('下载的更新包已失效，请重新下载。') }
}
