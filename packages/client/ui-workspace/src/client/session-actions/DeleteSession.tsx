/**
 * The delete action (fork-only; upstream has archive, not delete): a
 * `sidebar.workspaces.session.menu.item` row that raises the request, and the
 * `shell.overlay` dialog that confirms the permanent removal. Nothing leaves
 * the list here: the Host's `api-session/removed` is the only removal path, so
 * a refused or failed delete keeps its row and shows the reason in the dialog.
 */
import { useState } from 'react'
import { Button, IconTrashOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DeleteSessionInjected, SessionDeleteConfirmInjected, SessionDeleteConfirmProps, SessionDeleteConfirmRequest,
  SessionMenuItemProps,
} from '../contract/slots.ts'
import browserCss from '../rows/WorkspaceBrowser.module.css'

/**
 * Menu row (order 500): ask for the delete confirmation. Styled destructive,
 * unlike archive, because the log does not survive.
 * @param props - owner share, menu open state, and the delete share.
 * @returns the row.
 */
export function DeleteSessionMenuItem({
  sessionId, displayTitle, useMenuOpenState, requestSessionDelete, t,
}: SessionMenuItemProps<DeleteSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      danger
      icon={<IconTrashOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        requestSessionDelete(sessionId, displayTitle)
      }}
    >
      {t('menu.deleteSession')}
    </MenuItemButton>
  )
}

/**
 * The `shell.overlay` entry: nothing while no delete is requested, otherwise
 * one dialog per request (keyed by the Session).
 * @param props - the request hook, its settlement, the delete hop, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionDeleteConfirmDialog({
  useDeleteRequest, settleSessionDelete, deleteSession, t,
}: SessionDeleteConfirmProps) {
  const request = useDeleteRequest(pending => pending)
  if (request === null) return null
  return (
    <DeleteConfirmForm
      key={request.sessionId}
      request={request}
      deleteSession={deleteSession}
      onSettle={settleSessionDelete}
      t={t}
    />
  )
}

/** One request's dialog: in-flight and error state die with it. */
function DeleteConfirmForm({ request, deleteSession, onSettle, t }: {
  request: SessionDeleteConfirmRequest
  deleteSession: SessionDeleteConfirmInjected['deleteSession']
  onSettle: () => void
  t: SessionDeleteConfirmProps['t']
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    if (deleting) return
    onSettle()
  }
  const confirm = () => {
    setDeleting(true)
    setError(null)
    deleteSession(request.sessionId).then((failure) => {
      setDeleting(false)
      if (failure === undefined) onSettle()
      // The Host sends one generic sentence for every refusal; its code is what tells them apart.
      else setError(failure.reason === undefined ? failure.message : t(`delete.reason.${failure.reason}`))
    }).catch((reason: unknown) => {
      setDeleting(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('delete.session')}
      description={t('delete.sessionDesc', { name: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={close}>{t('cancel')}</Button>
          <Button variant="outline" className={browserCss.deleteAction} disabled={deleting} onClick={confirm}>
            {t('delete.session')}
          </Button>
        </>
      )}
    >
      {deleting && <div className={browserCss.deleteStatus} role="status">{t('delete.sessionPending')}</div>}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
