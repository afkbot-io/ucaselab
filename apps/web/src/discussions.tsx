import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Ref, RefObject, MouseEventHandler } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Copy, Send, Trash2, MessageSquare } from "lucide-react";
import { action } from "./api";
import { useProject, useSession } from "./context";
import type { UseCase, Anchor, Thread, Member } from "./types";
import {
  AsyncButton,
  Button,
  Dialog,
  Empty,
  ErrorState,
  Field,
  Form,
  Loading,
  date,
  useLoad,
  useToast,
} from "./ui";
import { CommentBody, DiscussionEditor } from "./discussion-editor";
import { anchorKey, useDiscussionDrafts } from "./discussion-drafts";

export function CommentsPanel(props: CommentsPanelProps) {
  const { project } = useProject(),
    { user } = useSession();
  const scope = JSON.stringify([
    user.id,
    project.id,
    props.targetType || "use_case",
    props.targetId || props.case_!.id,
  ]);
  return <ScopedCommentsPanel key={scope} {...props} scope={scope} />;
}

type CommentsPanelProps = {
  case_?: UseCase;
  targetType?: string;
  targetId?: string;
  anchor?: Anchor;
  clearAnchor: () => void;
  close: () => void;
  focusReturnRef?: RefObject<HTMLButtonElement | null>;
  selectedThreadId?: string | null;
};

function ScopedCommentsPanel({
  case_: c,
  targetType = "use_case",
  targetId,
  anchor: requestedAnchor,
  scope,
  clearAnchor,
  close,
  focusReturnRef,
  selectedThreadId,
}: CommentsPanelProps & { scope: string }) {
  const { project } = useProject(),
    { user } = useSession(),
    toast = useToast();
  const [discussionParams] = useSearchParams();
  const selectedThread =
    selectedThreadId === undefined
      ? discussionParams.get("thread")
      : selectedThreadId;
  const [draft, updateDraft] = useDiscussionDrafts(scope);
  useLayoutEffect(() => {
    if (requestedAnchor)
      updateDraft((d) => ({ ...d, anchor: requestedAnchor }));
  }, [requestedAnchor, updateDraft]);
  const anchor = draft.anchor,
    messageKey = anchorKey(anchor),
    body = draft.messages[messageKey] || "",
    reply = draft.replies;
  const setBody = (body: string) =>
    updateDraft((d) => ({
      ...d,
      messages: { ...d.messages, [messageKey]: body },
    }));
  const [mergingDrafts, setMergingDrafts] = useState(false);
  function detachAnchor(merge = false) {
    updateDraft((d) => {
      const current = d.messages[anchorKey(d.anchor)] || "";
      const general = d.messages.general || "";
      return {
        ...d,
        anchor: undefined,
        messages: {
          ...d.messages,
          general:
            merge && general !== current
              ? [current, general].filter(Boolean).join("\n\n")
              : current,
        },
      };
    });
    setMergingDrafts(false);
    clearAnchor();
  }
  function removeAnchor() {
    if (draft.messages.general && draft.messages.general !== body) {
      setMergingDrafts(true);
      return;
    }
    detachAnchor();
  }
  const [showResolved, setShowResolved] = useState(!!selectedThread),
    [editingId, setEditingId] = useState<string | null>(null),
    [moderating, setModerating] = useState<{
      id: string;
      reason: string;
    } | null>(null);
  const editing = editingId
    ? { id: editingId, body: draft.edits[editingId] || "" }
    : null;
  const id = targetId || c!.id;
  const target =
    targetType === "use_case"
      ? { use_case_id: id }
      : { target_type: targetType, target_id: id };
  const threads = useLoad(
    () =>
      action<{ items: Thread[]; eligible_member_ids: string[] }>(
        "list_comment_threads",
        project.id,
        {
          ...target,
        },
      ),
    [project.id, id],
  );
  useEffect(() => {
    if (selectedThread && threads.data)
      document
        .getElementById("thread-" + selectedThread)
        ?.scrollIntoView({ block: "nearest" });
  }, [selectedThread, threads.data]);
  const members = useLoad(
    () => action<{ items: Member[] }>("list_project_members", project.id),
    [project.id],
  );
  const names = Object.fromEntries(
    members.data?.items.map((m) => [m.user_id, m.name]) || [],
  );
  const eligibleMembers = (members.data?.items || []).filter(
    (m) =>
      !threads.data?.eligible_member_ids ||
      threads.data.eligible_member_ids.includes(m.user_id),
  );
  const qaMembers = eligibleMembers.filter((m) => m.role !== "developer");
  const editingThread = threads.data?.items.find((t) =>
    t.comments.some((c) => c.id === editing?.id),
  );
  const draftAnchor =
    targetType === "use_case" && c && anchor && c.has_unpublished_changes;
  const qa = project.role !== "developer";
  return (
    <Dialog
      title="Обсуждения"
      focusReturnRef={focusReturnRef}
      onClose={close}
      className="discussion-drawer"
      focusField={false}
      modal={false}
    >
      <div className="comments-panel">
        <label className="check-label small">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Показывать завершённые
        </label>
        <div className="threads-list">
          {threads.loading ? (
            <Loading />
          ) : threads.error ? (
            <ErrorState error={threads.error} retry={threads.reload} />
          ) : !threads.data?.items.filter((t) => showResolved || !t.resolved)
              .length ? (
            <Empty
              title="Начните обсуждение"
              description="Задайте вопрос или обсудите доработку. Обсуждение не меняет результат проверки."
            />
          ) : (
            threads.data.items
              .filter((t) => showResolved || !t.resolved)
              .map((t) => (
                <div
                  className={"thread " + (t.resolved ? "resolved" : "")}
                  key={t.id}
                  id={"thread-" + t.id}
                >
                  {t.anchor && (
                    <div className="thread-anchor">
                      <span>
                        {t.anchor.step_key ? "Шаг сценария" : "Вариант данных"}
                      </span>
                      <p>{t.anchor.quote}</p>
                      {t.anchor_status !== "current" && (
                        <small>
                          {t.anchor_status === "target_removed"
                            ? "Фрагмент удалён"
                            : "Привязка к предыдущей версии"}
                        </small>
                      )}
                    </div>
                  )}
                  {t.visibility === "qa_team" && (
                    <span className="tag">Только команда QA</span>
                  )}
                  {t.comments.map((comment) => (
                    <div className="comment" key={comment.id}>
                      <div className="comment-author">
                        <span className="avatar">
                          {(names[comment.author_id] || "?").slice(0, 1)}
                        </span>
                        <strong>
                          {names[comment.author_id] || "Участник"}
                        </strong>
                        <small>{date(comment.created_at)}</small>
                      </div>
                      <div
                        className={
                          "comment-body " + (comment.deleted ? "deleted" : "")
                        }
                      >
                        {comment.deleted ? (
                          "Комментарий удалён"
                        ) : (
                          <CommentBody body={comment.body} names={names} />
                        )}
                      </div>
                      {comment.updated_at && !comment.deleted && (
                        <small>Изменён</small>
                      )}
                      {!comment.deleted && comment.author_id === user.id && (
                        <div className="inline">
                          <button
                            className="text-link"
                            onClick={() => {
                              updateDraft((d) => ({
                                ...d,
                                edits: {
                                  ...d.edits,
                                  [comment.id]:
                                    d.edits[comment.id] ?? comment.body,
                                },
                              }));
                              setEditingId(comment.id);
                            }}
                          >
                            Изменить
                          </button>
                          <AsyncButton
                            className="tiny"
                            variant="ghost"
                            onAction={async () => {
                              await action("delete_comment", project.id, {
                                comment_id: comment.id,
                              });
                              threads.reload();
                            }}
                          >
                            Удалить
                          </AsyncButton>
                        </div>
                      )}
                      {!comment.deleted &&
                        qa &&
                        comment.author_id !== user.id && (
                          <Button
                            variant="ghost"
                            className="tiny"
                            onClick={() =>
                              setModerating({ id: comment.id, reason: "" })
                            }
                          >
                            Скрыть комментарий
                          </Button>
                        )}
                    </div>
                  ))}
                  <div className="inline spaced">
                    <AsyncButton
                      variant="ghost"
                      className="tiny"
                      disabled={!qa && t.author_id !== user.id}
                      onAction={async () => {
                        await action("resolve_comment_thread", project.id, {
                          thread_id: t.id,
                          resolved: !t.resolved,
                        });
                        threads.reload();
                      }}
                    >
                      <Check size={13} />
                      {t.resolved ? "Открыть снова" : "Решено"}
                    </AsyncButton>
                    <button
                      className="icon-button"
                      title="Ссылка на обсуждение"
                      aria-label="Ссылка на обсуждение"
                      onClick={async () => {
                        await navigator.clipboard.writeText(
                          `${location.origin}${t.path}`,
                        );
                        toast("Ссылка скопирована");
                      }}
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                  <Form
                    onSubmit={async () => {
                      await action("create_comment", project.id, {
                        thread_id: t.id,
                        body: reply[t.id],
                      });
                      updateDraft((d) => ({
                        ...d,
                        replies: {
                          ...d.replies,
                          [t.id]:
                            d.replies[t.id] === reply[t.id]
                              ? ""
                              : d.replies[t.id],
                        },
                      }));
                      threads.reload();
                    }}
                  >
                    <div className="reply-form">
                      <DiscussionEditor
                        label="Ответить"
                        rows={2}
                        value={reply[t.id] || ""}
                        onChange={(value) =>
                          updateDraft((d) => ({
                            ...d,
                            replies: { ...d.replies, [t.id]: value },
                          }))
                        }
                        members={
                          t.visibility === "qa_team"
                            ? qaMembers
                            : eligibleMembers
                        }
                      />
                      <Button
                        type="submit"
                        variant="ghost"
                        aria-label="Отправить ответ"
                      >
                        <Send size={14} />
                      </Button>
                    </div>
                  </Form>
                </div>
              ))
          )}
        </div>
        <div className="new-thread">
          {anchor && (
            <div className="inline spaced thread-anchor">
              <span>Комментарий к фрагменту: {anchor.quote?.slice(0, 65)}</span>
              <button
                className="icon-button"
                onClick={removeAnchor}
                aria-label="Убрать привязку"
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}
          <Form
            onSubmit={async () => {
              await action("create_comment_thread", project.id, {
                ...target,
                body,
                anchor: anchor || null,
              });
              updateDraft((d) => ({
                ...d,
                anchor:
                  anchorKey(d.anchor) === messageKey &&
                  d.messages[messageKey] === body
                    ? undefined
                    : d.anchor,
                messages: {
                  ...d.messages,
                  [messageKey]:
                    d.messages[messageKey] === body
                      ? ""
                      : d.messages[messageKey],
                },
              }));
              clearAnchor();
              threads.reload();
            }}
          >
            <div className="field">
              <DiscussionEditor
                label="Новое обсуждение"
                value={body}
                onChange={setBody}
                members={draftAnchor ? qaMembers : eligibleMembers}
              />
            </div>
            <div className="inline spaced">
              <Button type="submit">
                <Send size={14} />
                Отправить
              </Button>
            </div>
          </Form>
        </div>
        {mergingDrafts && (
          <Dialog
            title="Убрать привязку?"
            onClose={() => setMergingDrafts(false)}
          >
            <p className="dialog-description">
              У вас уже есть общий черновик. При объединении текст к фрагменту
              останется первым, а общий текст добавится после пустой строки.
            </p>
            <div className="draft-merge-preview">
              <h3>Комментарий к фрагменту</h3>
              <p>{body || "Текст не введён"}</p>
              <h3>Ранее введённый общий текст</h3>
              <p>{draft.messages.general}</p>
            </div>
            <div className="form-footer draft-merge-actions">
              <Button
                variant="secondary"
                onClick={() => setMergingDrafts(false)}
              >
                Отмена
              </Button>
              <Button onClick={() => detachAnchor(true)}>
                Объединить и убрать привязку
              </Button>
            </div>
          </Dialog>
        )}
        {moderating && (
          <Dialog
            title="Скрыть комментарий"
            onClose={() => setModerating(null)}
          >
            <p className="dialog-description">
              Комментарий исчезнет из обсуждения. Причина, исходный текст и
              автор действия сохранятся в истории.
            </p>
            <Form
              onSubmit={async () => {
                await action("moderate_comment", project.id, {
                  comment_id: moderating.id,
                  reason: moderating.reason,
                });
                setModerating(null);
                threads.reload();
                toast("Комментарий скрыт");
              }}
            >
              <Field label="Причина скрытия">
                <textarea
                  required
                  maxLength={240}
                  value={moderating.reason}
                  onChange={(e) =>
                    setModerating({ ...moderating, reason: e.target.value })
                  }
                />
              </Field>
              <div className="form-footer">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setModerating(null)}
                >
                  Отмена
                </Button>
                <Button
                  type="submit"
                  variant="danger"
                  disabled={!moderating.reason.trim()}
                >
                  Скрыть комментарий
                </Button>
              </div>
            </Form>
          </Dialog>
        )}
        {editing && (
          <Dialog
            title="Изменить комментарий"
            onClose={() => setEditingId(null)}
          >
            <Form
              onSubmit={async () => {
                await action("update_comment", project.id, {
                  comment_id: editing.id,
                  body: editing.body,
                });
                updateDraft((d) => {
                  const edits = { ...d.edits };
                  if (edits[editing.id] === editing.body)
                    delete edits[editing.id];
                  return { ...d, edits };
                });
                setEditingId(null);
                threads.reload();
              }}
            >
              <div className="field">
                <DiscussionEditor
                  label="Текст"
                  value={editing.body}
                  onChange={(body) =>
                    updateDraft((d) => ({
                      ...d,
                      edits: { ...d.edits, [editing.id]: body },
                    }))
                  }
                  members={
                    editingThread?.visibility === "qa_team"
                      ? qaMembers
                      : eligibleMembers
                  }
                />
              </div>
              <Button type="submit">Сохранить</Button>
            </Form>
          </Dialog>
        )}
      </div>
    </Dialog>
  );
}

/** The same labeled icon action for documents, modal views and execution headers. */
export function DiscussionTrigger({
  expanded,
  onClick,
  buttonRef,
}: {
  expanded: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      className={
        "icon-button discussion-trigger" + (expanded ? " selected" : "")
      }
      aria-label="Обсуждения"
      title="Обсуждения"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        onClick(event);
      }}
    >
      <MessageSquare size={19} aria-hidden="true" />
    </button>
  );
}

export function DiscussionButton({
  targetType,
  targetId,
  followThreadLink = true,
}: {
  targetType: string;
  targetId: string;
  followThreadLink?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const [openedTarget, setOpenedTarget] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // A drawer must escape header typography, while remaining inside a native
    // modal when opened from one (a body portal would be inert there).
    setHost(trigger.current?.closest("dialog") || document.body);
  }, []);
  const selectedThread = followThreadLink ? params.get("thread") : null;
  // Derive linked visibility from the URL. An effect copying it into local state
  // could close a keyboard-reopened drawer after the URL was cleared.
  const open = openedTarget === targetId || !!selectedThread;
  function close() {
    setOpenedTarget(null);
    if (selectedThread)
      setParams(
        (p) => {
          p.delete("thread");
          return p;
        },
        { replace: true },
      );
  }
  return (
    <>
      <DiscussionTrigger
        buttonRef={trigger}
        expanded={open}
        onClick={() => (open ? close() : setOpenedTarget(targetId))}
      />
      {open &&
        host &&
        createPortal(
          <CommentsPanel
            targetType={targetType}
            targetId={targetId}
            focusReturnRef={trigger}
            selectedThreadId={selectedThread}
            clearAnchor={() => {}}
            close={close}
          />,
          host,
        )}
    </>
  );
}
