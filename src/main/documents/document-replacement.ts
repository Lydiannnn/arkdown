/** Main-only, verified paths and byte revisions for an already flushed save. */
export interface DocumentReplacementRequest {
  readonly temporaryPath: string
  readonly destinationPath: string
  readonly temporaryIdentity: string
  readonly destinationIdentity: string
  readonly replacementRevision: string
  readonly expectedRevision: string
}
