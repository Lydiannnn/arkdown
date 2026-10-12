import { ArkdownDialog } from '../modal/ArkdownDialog'

export type FolderDropChoice = 'workspace' | 'path' | 'cancel'

export function FolderDropDialog(props: {
  onChoose(choice: FolderDropChoice): void
}) {
  return (
    <ArkdownDialog
      actions={({ requestClose }) => <>
        <button
          className="arkdown-dialog__primary folder-drop-workspace"
          onClick={() => requestClose(() => props.onChoose('workspace'))}
          type="button"
        >工作区</button>
        <button
          onClick={() => requestClose(() => props.onChoose('path'))}
          type="button"
        >路径</button>
        <button
          onClick={() => requestClose(() => props.onChoose('cancel'))}
          type="button"
        >取消</button>
      </>}
      cancelOnBackdrop={false}
      className="workspace-name-dialog folder-drop-dialog"
      description="将文件夹以工作区的方式打开，还是将文件夹路径加入正文？"
      onCancel={() => props.onChoose('cancel')}
      size="small"
      title="添加文件夹"
    />
  )
}
