/**
 * 合并审批视图（设计稿「合并审批」屏）：待审批卡（patch 摘要 + diff 预览 +
 * 记住规则 + 驳回原因 + 批准/驳回）+ 最近审批历史表。
 * diff 来自后端（落盘 diff 或 base..head 现算），无可读 diff 时降级为摘要。
 */
import { createElement, useEffect, useState, type ReactElement } from 'react'
import { fetchApprovalDetail, fetchMissionArchive, type ApprovalDetail } from './api.js'
import { Icon } from './icons.js'
import { fmtDateTime } from './view-helpers.js'

export interface ApprovalViewProps {
  approvalId: string
  onBack: () => void
  onApprove: (id: string, remember: boolean) => void
  onDeny: (id: string, reason: string) => void
}

interface DiffRow { mark: string; text: string }

function parseDiff(diff: string): { rows: DiffRow[]; adds: number; dels: number } {
  const rows: DiffRow[] = []
  let adds = 0
  let dels = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) { rows.push({ mark: '+', text: line.slice(1) }); adds += 1 }
    else if (line.startsWith('-')) { rows.push({ mark: '-', text: line.slice(1) }); dels += 1 }
    else if (line.startsWith('@@')) rows.push({ mark: '@', text: line })
    else rows.push({ mark: ' ', text: line })
  }
  return { rows: rows.slice(0, 400), adds, dels }
}

export function ApprovalView(props: ApprovalViewProps): ReactElement {
  const { approvalId, onBack, onApprove, onDeny } = props
  const [detail, setDetail] = useState<ApprovalDetail | null>(null)
  const [history, setHistory] = useState<Array<{ id: string; status: string; decided_at: number | null; task_id: string | null; summary: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [remember, setRemember] = useState(true)
  const [reason, setReason] = useState('')

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setError(null)
    fetchApprovalDetail(approvalId)
      .then((d) => {
        if (cancelled) return
        setDetail(d)
        return fetchMissionArchive(d.mission_id)
      })
      .then((archive) => {
        if (cancelled || archive === undefined) return
        setHistory(
          archive.approvals
            .filter((a) => a.status !== 'pending')
            .sort((a, b) => (b.decided_at ?? 0) - (a.decided_at ?? 0))
            .slice(0, 5),
        )
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [approvalId])

  const diff = detail?.diff !== null && detail?.diff !== undefined ? parseDiff(detail.diff) : undefined

  return createElement('div', { className: 'dsh-view' },
    createElement('div', { className: 'dsh-board-bar' },
      createElement('button', { className: 'dsh-btn sm ghost', type: 'button', onClick: onBack }, Icon('arrowRight', 13), '返回'),
      createElement('span', { style: { flex: 1 } }),
      detail?.status === 'pending'
        ? createElement('span', { className: 'dsh-pill wait' }, '待审批')
        : null),
    createElement('div', { className: 'dsh-approval-wrap' },
      error !== null
        ? createElement('div', { className: 'dsh-empty' }, Icon('alertTriangle', 22), createElement('div', { className: 'dsh-empty-title' }, '无法加载审批'), createElement('div', { className: 'dsh-empty-sub' }, error))
        : detail === null
          ? createElement('div', { className: 'dsh-empty' }, '读取审批详情…')
          : createElement('div', { className: 'dsh-approval-card' },
              createElement('div', { className: 'dsh-approval-head' },
                createElement('div', null,
                  createElement('div', { className: 'dsh-approval-title' }, '待审批合并'),
                  createElement('div', { className: 'dsh-hint', style: { marginTop: 4 } }, '请确认是否将 Agent worktree 的变更合并到主分支。')),
                createElement('span', { className: 'dsh-pill wait' }, '等待用户决策')),
              createElement('div', { style: { background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, padding: 14, marginBottom: 16 } },
                createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 8 } },
                  createElement('span', { style: { fontSize: 14.5, fontWeight: 600 } }, `补丁 · ${detail.task_id ?? detail.id}`),
                  diff !== undefined
                    ? createElement('span', { className: 'dsh-mono', style: { fontSize: 12.5 } },
                        createElement('span', { style: { color: 'var(--success)' } }, `+${diff.adds}`), ' / ',
                        createElement('span', { style: { color: 'var(--error)' } }, `-${diff.dels}`))
                    : null),
                createElement('div', { style: { fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 } }, detail.summary),
                createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--ink-3)', marginTop: 8 } },
                  Icon('gitBranch', 12),
                  createElement('code', { className: 'dsh-mono', style: { wordBreak: 'break-all' } }, detail.worktree_path)),
                detail.base_commit !== null && detail.head_commit !== null
                  ? createElement('div', { className: 'dsh-mono', style: { fontSize: 11, color: 'var(--ink-3)', marginTop: 4 } }, `${detail.base_commit.slice(0, 8)}..${detail.head_commit.slice(0, 8)}`)
                  : null),
              diff !== undefined && diff.rows.length > 0
                ? createElement('div', { style: { marginBottom: 16 } },
                    createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12.5 } },
                      createElement('span', { style: { fontWeight: 500 } }, '变更预览'),
                      createElement('span', { className: 'dsh-hint' }, diff.rows.length >= 400 ? '（超长已截断）' : '')),
                    createElement('div', { className: 'dsh-diff-box' },
                      diff.rows.map((row, i) => createElement('div', {
                        key: i,
                        className: row.mark === '+' ? 'dsh-diff-line add' : row.mark === '-' ? 'dsh-diff-line del' : 'dsh-diff-line',
                      },
                        createElement('span', { className: 'mark' }, row.mark),
                        createElement('span', null, row.text || ' ')))))
                : createElement('div', { className: 'dsh-hint', style: { marginBottom: 16 } }, '（无可读 diff——worktree 已清理或 commits 不可解析，以摘要为准）'),
              detail.status === 'pending'
                ? createElement('div', null,
                    createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginBottom: 14 } },
                      createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 } },
                        createElement('input', { type: 'checkbox', checked: remember, onChange: (e: { target: { checked: boolean } }) => setRemember(e.target.checked) }),
                        '记住规则'),
                      createElement('input', {
                        className: 'dsh-input', style: { flex: 1, minWidth: 220, height: 36 },
                        placeholder: '若驳回，填写原因或规则说明…', value: reason,
                        onChange: (e: { target: { value: string } }) => setReason(e.target.value),
                      })),
                    createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
                      createElement('button', { className: 'dsh-btn primary', type: 'button', onClick: () => onApprove(detail.id, remember) }, Icon('check', 15), '批准并合并'),
                      createElement('button', { className: 'dsh-btn destructive', type: 'button', onClick: () => onDeny(detail.id, reason.trim().length > 0 ? reason.trim() : 'denied via approval view') }, Icon('x', 15), '驳回')))
                : createElement('div', { className: 'dsh-hint' }, `该审批已处理（${detail.status}${detail.decided_at !== null ? ` · ${fmtDateTime(detail.decided_at)}` : ''}）`)),
      history.length > 0
        ? createElement('div', { style: { maxWidth: 720 } },
            createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 10 } },
              createElement('span', { style: { fontSize: 14.5, fontWeight: 600 } }, '最近审批')),
            createElement('div', { className: 'dsh-history-table' },
              createElement('div', { className: 'dsh-history-row head' },
                createElement('span', null, 'ID'), createElement('span', null, '任务/摘要'), createElement('span', null, '结果'), createElement('span', null, '时间')),
              history.map((a) => createElement('div', { className: 'dsh-history-row', key: a.id },
                createElement('span', { className: 'dsh-mono' }, a.id.replace(/^A-/, '#')),
                createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.summary.slice(0, 60)),
                createElement('span', {
                  style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500, color: a.status === 'approved' ? 'var(--success)' : a.status === 'denied' ? 'var(--error)' : 'var(--ink-3)' },
                }, a.status === 'approved' ? Icon('checkCircle', 13) : Icon('xCircle', 13), a.status === 'approved' ? '通过' : a.status === 'denied' ? '驳回' : a.status),
                createElement('span', { style: { fontSize: 12, color: 'var(--ink-3)' } }, a.decided_at !== null ? fmtDateTime(a.decided_at) : '—')))))
        : null))
}
