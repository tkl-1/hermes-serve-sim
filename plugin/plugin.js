/**
 * simtest — iOS Simulator + serve-sim control (statusbar chip + ⌘K commands).
 *
 * Backend: ~/.hermes/plugins/simtest/dashboard/plugin_api.py
 *   GET  /api/plugins/simtest/status → { sim_booted, serve_sim, pid }
 *   POST /api/plugins/simtest/on|off → { ok, exit_code, output }
 *
 * Plain ESM, loaded uncompiled — UI is jsx() calls, not JSX syntax.
 * Only these imports resolve: @hermes/plugin-sdk, react, react/jsx-runtime.
 */

import {
  Button,
  cn,
  EmptyState,
  haptic,
  host,
  useMutation,
  useQuery,
  queryClient,
  StatusDot,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  PALETTE_AREA,
  PANES_AREA,
  STATUSBAR_AREAS
} from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'

const ID = 'simtest'
const STATUS_QUERY = [ID, 'status']

// ctx is only available inside register(); keep it for the queryFn/actions.
let pluginCtx = null

/** Single /status poll — shared by the chip and the Sim pane (same query key). */
function useStatus() {
  return useQuery({
    queryKey: STATUS_QUERY,
    queryFn: () => pluginCtx.rest('/status'),
    refetchInterval: 10000
  })
}

function firstLine(text) {
  if (!text) return ''
  const line = String(text).split('\n')[0].trim()
  return line.length > 90 ? `${line.slice(0, 90)}…` : line
}

/** POST /on or /off, invalidate the status query, surface the script output. */
async function perform(action) {
  try {
    const r = await pluginCtx.rest(`/${action}`, { method: 'POST', timeoutMs: 95000 })
    queryClient.invalidateQueries({ queryKey: STATUS_QUERY })
    if (r && r.ok) {
      host.notify({ kind: 'success', message: firstLine(r.output) || `simtest ${action} OK` })
    } else {
      host.notify({ kind: 'error', message: firstLine(r && r.output) || `simtest ${action} failed` })
    }
    return r
  } catch (err) {
    host.notifyError(err, `simtest ${action} failed`)
    return null
  }
}

/** Fetch /status and report it in a toast. */
async function reportStatus() {
  try {
    const s = await pluginCtx.rest('/status')
    const parts = [`Sim: ${s.sim_booted ? 'on' : 'off'}`, `serve-sim: ${s.serve_sim ? 'on' : 'off'}`]
    if (s.pid) parts.push(`PID ${s.pid}`)
    host.notify({ kind: 'info', message: parts.join(' · ') })
  } catch (err) {
    host.notifyError(err, 'Could not fetch status')
  }
}

function SimChip() {
  // React Query poll — never hand-roll a fetch loop.
  const { data } = useStatus()
  const mutation = useMutation({ mutationFn: perform })
  const busy = mutation.isPending
  const on = !!(data && (data.sim_booted || data.serve_sim))

  return jsx(DropdownMenu, {
    children: [
      jsx(DropdownMenuTrigger, {
        asChild: true,
        children: jsx('button', {
          type: 'button',
          title: 'Sim + serve-sim control',
          className: cn(
            'inline-flex h-full items-center gap-1.5 px-2 text-[0.6875rem] transition-colors',
            'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          ),
          children: [
            jsx(StatusDot, { tone: on ? 'good' : 'muted' }),
            jsx('span', { children: '🖥 Sim' })
          ]
        })
      }),
      jsx(DropdownMenuContent, {
        align: 'end',
        className: 'w-44',
        children: [
          jsx(DropdownMenuItem, {
            disabled: busy,
            onSelect: () => {
              haptic('tap')
              mutation.mutate('on')
            },
            children: 'Turn Sim On'
          }),
          jsx(DropdownMenuItem, {
            disabled: busy,
            onSelect: () => {
              haptic('tap')
              mutation.mutate('off')
            },
            children: 'Turn Sim Off'
          }),
          jsx(DropdownMenuSeparator, {}),
          jsx(DropdownMenuItem, {
            onSelect: () => {
              haptic('tap')
              void reportStatus()
            },
            children: 'Status'
          })
        ]
      })
    ]
  })
}

/**
 * "Sim" pane — persistent panel: live stream (iframe) while serve-sim is up,
 * a "Turn On" button while it's down. Shares the same useStatus() poll as the chip.
 */
const SIM_STREAM_URL = 'http://localhost:3200'

function SimPane() {
  const { data } = useStatus()
  const mutation = useMutation({ mutationFn: perform })
  const busy = mutation.isPending
  const on = !!(data && data.serve_sim)

  // serve-sim up → live stream: interactive iframe of the serve-sim UI.
  if (on) {
    return jsx('div', {
      className: 'h-full w-full overflow-hidden',
      children: jsx('iframe', {
        src: SIM_STREAM_URL,
        title: 'Live simulator stream (serve-sim)',
        style: {
          width: '100%',
          height: '100%',
          border: 'none',
          display: 'block',
          background: 'var(--ui-editor-background)'
        }
      })
    })
  }

  // Down → empty state + turn-on button.
  return jsx('div', {
    className: 'flex h-full w-full flex-col items-center justify-center gap-3 p-4',
    children: [
      jsx(EmptyState, {
        title: 'Sim is off',
        description: 'serve-sim is not running — turn it on to see the live stream.'
      }),
      jsx(Button, {
        variant: 'default',
        size: 'sm',
        disabled: busy,
        onClick: () => {
          haptic('tap')
          mutation.mutate('on')
        },
        children: busy ? 'Starting…' : 'Turn Sim On'
      })
    ]
  })
}

export default {
  id: ID, // must match the folder name
  name: 'Simtest',
  register(ctx) {
    pluginCtx = ctx

    // Persistent "Sim" pane — docked to the right edge of the workspace, 360px.
    // dock gesture pins the pane to a specific edge; without it, `placement`
    // only stacks (as tabs) with existing panes of that role and the pane can
    // end up in the files/left zone when no right zone exists yet.
    ctx.register({
      id: 'sim-pane',
      area: PANES_AREA,
      title: 'Sim',
      order: 200,
      data: {
        placement: 'right',
        dock: { pane: 'workspace', pos: 'right' },
        width: '360px'
      },
      render: () => jsx(SimPane, {})
    })

    // Statusbar chip (right cluster) — dot: green = on, grey = off.
    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 130,
      render: () => jsx(SimChip, {})
    })

    // ⌘K commands.
    ctx.registerMany([
      {
        id: 'pal-on',
        area: PALETTE_AREA,
        data: {
          id: 'simtest.on',
          label: 'Simtest: Turn On',
          keywords: ['sim', 'simtest', 'serve-sim', 'on'],
          run: () => {
            haptic('tap')
            void perform('on')
          }
        }
      },
      {
        id: 'pal-off',
        area: PALETTE_AREA,
        data: {
          id: 'simtest.off',
          label: 'Simtest: Turn Off',
          keywords: ['sim', 'simtest', 'serve-sim', 'off'],
          run: () => {
            haptic('tap')
            void perform('off')
          }
        }
      },
      {
        id: 'pal-status',
        area: PALETTE_AREA,
        data: {
          id: 'simtest.status',
          label: 'Simtest: Status',
          keywords: ['sim', 'simtest', 'serve-sim', 'status'],
          run: () => {
            haptic('tap')
            void reportStatus()
          }
        }
      }
    ])
  }
}
